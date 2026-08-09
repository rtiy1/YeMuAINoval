import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { z } from "@yemu/model-runtime";

const MAX_URL_LENGTH = 2_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MARKDOWN_CHARS = 80_000;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;

export const webFetchSchema = z.object({
	url: z.string().url().max(MAX_URL_LENGTH),
	prompt: z.string().max(1_000).optional(),
});

export type WebFetchParams = z.infer<typeof webFetchSchema>;

interface LookupAddress {
	address: string;
	family: number;
}

interface WebFetchOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	lookupImpl?: (hostname: string) => Promise<LookupAddress[]>;
}

export interface HeadlessWebFetchResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		url: string;
		finalUrl: string;
		status: number;
		contentType: string;
		title?: string;
		bytes: number;
		chars: number;
		redirects: number;
		truncated: boolean;
	};
}

function ipv4Value(address: string): number | undefined {
	const parts = address.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		value = value * 256 + octet;
	}
	return value >>> 0;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	return (value & mask) === (base & mask);
}

function isPublicIpv4(address: string): boolean {
	const value = ipv4Value(address);
	if (value === undefined) return false;
	const blocked: Array<[string, number]> = [
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["127.0.0.0", 8],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["192.168.0.0", 16],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	];
	return !blocked.some(([base, prefix]) => inIpv4Range(value, ipv4Value(base) ?? 0, prefix));
}

function isPublicIpv6(address: string): boolean {
	const normalized = address.toLowerCase().split("%")[0];
	const mappedIpv4 = /(?:^|:)ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
	if (mappedIpv4) return isPublicIpv4(mappedIpv4);
	if (isIP(normalized) !== 6) return false;
	return normalized !== "::"
		&& normalized !== "::1"
		&& !/^(?:fc|fd)/.test(normalized)
		&& !/^fe[89ab]/.test(normalized)
		&& !/^ff/.test(normalized)
		&& !/^2001:(?:db8|10|2)(?::|$)/.test(normalized)
		&& !/^3fff(?::|$)/.test(normalized);
}

export function isPublicWebAddress(address: string): boolean {
	const family = isIP(address);
	return family === 4 ? isPublicIpv4(address) : family === 6 ? isPublicIpv6(address) : false;
}

function normalizedHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, "");
}

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
	return await lookup(hostname, { all: true, verbatim: true });
}

async function validatePublicUrl(
	value: string,
	lookupImpl: (hostname: string) => Promise<LookupAddress[]>,
): Promise<URL> {
	if (value.length > MAX_URL_LENGTH) throw new Error(`URL 过长，最多 ${MAX_URL_LENGTH} 个字符`);
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("仅支持 HTTP(S) 网页");
	if (url.username || url.password) throw new Error("URL 不能包含用户名或密码");
	if (url.port && !["80", "443"].includes(url.port)) throw new Error("不允许访问非标准 Web 端口");
	const hostname = normalizedHostname(url.hostname);
	if (!hostname || hostname === "localhost" || !hostname.includes(".")) throw new Error("不允许访问本地或内网主机");
	if ([".localhost", ".local", ".internal", ".home.arpa", ".invalid", ".test", ".example"]
		.some(suffix => hostname.endsWith(suffix))) {
		throw new Error("不允许访问本地或保留域名");
	}
	if (isIP(hostname)) {
		if (!isPublicWebAddress(hostname)) throw new Error("不允许访问内网或保留 IP");
		return url;
	}
	const addresses = await lookupImpl(hostname);
	if (!addresses.length || addresses.some(item => !isPublicWebAddress(item.address))) {
		throw new Error("域名未解析到可公开访问的 IP");
	}
	return url;
}

function combinedSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		throw new Error(`网页超过 ${MAX_RESPONSE_BYTES / 1024 / 1024} MB 限制`);
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new Error(`网页超过 ${MAX_RESPONSE_BYTES / 1024 / 1024} MB 限制`);
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function supportedContentType(value: string): boolean {
	const type = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return !type
		|| type.startsWith("text/")
		|| ["application/json", "application/ld+json", "application/xml", "application/xhtml+xml"].includes(type);
}

function htmlToMarkdown(html: string, sourceUrl: string): { markdown: string; title?: string } {
	const { document } = parseHTML(html);
	const article = new Readability(
		document as unknown as ConstructorParameters<typeof Readability>[0],
		{ charThreshold: 20 },
	).parse();
	const content = article?.content || document.body?.innerHTML || html;
	const turndown = new TurndownService({
		headingStyle: "atx",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
	});
	turndown.use(gfm);
	turndown.remove(["script", "style", "noscript", "svg", "canvas"]);
	const markdown = turndown.turndown(content).replace(/\n{4,}/g, "\n\n\n").trim();
	return {
		markdown: markdown || `该页面没有可提取的正文：${sourceUrl}`,
		title: article?.title?.trim() || document.title?.trim() || undefined,
	};
}

function textContentToMarkdown(text: string, contentType: string, sourceUrl: string): { markdown: string; title?: string } {
	if (/html|xhtml/i.test(contentType) || /^\s*<(?:!doctype\s+html|html\b)/i.test(text)) {
		return htmlToMarkdown(text, sourceUrl);
	}
	if (/json/i.test(contentType)) {
		try {
			return { markdown: `\`\`\`json\n${JSON.stringify(JSON.parse(text), null, 2)}\n\`\`\`` };
		} catch {
			return { markdown: text.trim() };
		}
	}
	return { markdown: text.trim() };
}

export async function runWebFetch(
	params: WebFetchParams,
	options: WebFetchOptions = {},
): Promise<HeadlessWebFetchResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const lookupImpl = options.lookupImpl ?? defaultLookup;
	const signal = combinedSignal(options.signal);
	let currentUrl = params.url;
	let redirects = 0;
	let response: Response | undefined;
	while (redirects <= MAX_REDIRECTS) {
		const validated = await validatePublicUrl(currentUrl, lookupImpl);
		response = await fetchImpl(validated, {
			method: "GET",
			redirect: "manual",
			headers: {
				Accept: "text/markdown, text/html, text/plain, application/json, application/xml;q=0.9",
				"User-Agent": "Mozilla/5.0 (compatible; YeMuWebFetch/1.0; +https://github.com/rtiy1/YeMuAINoval)",
			},
			signal,
		});
		if (![301, 302, 303, 307, 308].includes(response.status)) break;
		const location = response.headers.get("location");
		if (!location) throw new Error("网页重定向缺少 Location");
		await response.body?.cancel().catch(() => undefined);
		redirects += 1;
		if (redirects > MAX_REDIRECTS) throw new Error(`网页重定向超过 ${MAX_REDIRECTS} 次`);
		currentUrl = new URL(location, validated).toString();
	}
	if (!response) throw new Error("网页请求未执行");
	if (!response.ok) {
		const errorBytes = await boundedResponseBytes(response);
		const errorText = new TextDecoder("utf-8", { fatal: false }).decode(errorBytes).slice(0, 300);
		throw new Error(`Web Fetch HTTP ${response.status}: ${errorText}`);
	}
	const contentType = response.headers.get("content-type") || "";
	if (!supportedContentType(contentType)) throw new Error(`暂不支持的网页类型：${contentType || "unknown"}`);
	const bytes = await boundedResponseBytes(response);
	const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const extracted = textContentToMarkdown(decoded, contentType, currentUrl);
	const truncated = extracted.markdown.length > MAX_MARKDOWN_CHARS;
	const markdown = truncated
		? `${extracted.markdown.slice(0, MAX_MARKDOWN_CHARS)}\n\n[网页内容过长，已截断]`
		: extracted.markdown;
	const heading = extracted.title ? `# ${extracted.title}\n\n` : "";
	const prompt = params.prompt?.trim() ? `Fetch focus: ${params.prompt.trim()}\n\n` : "";
	return {
		content: [{
			type: "text",
			text: `${heading}Source: ${currentUrl}\n\n${prompt}${markdown}`,
		}],
		details: {
			url: params.url,
			finalUrl: currentUrl,
			status: response.status,
			contentType,
			title: extracted.title,
			bytes: bytes.byteLength,
			chars: markdown.length,
			redirects,
			truncated,
		},
	};
}
