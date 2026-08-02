import { z } from "@yemu/model-runtime";

export const webSearchSchema = z.object({
	query: z.string().min(1).max(1_000),
	recency: z.enum(["day", "week", "month", "year"]).optional(),
	limit: z.number().int().min(1).max(20).optional(),
	max_tokens: z.number().int().positive().optional(),
	temperature: z.number().min(0).optional(),
	num_search_results: z.number().int().min(1).max(20).optional(),
});

export type SearchQueryParams = z.infer<typeof webSearchSchema>;

interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
}

interface SearchResponse {
	provider: "tavily" | "duckduckgo" | "none";
	answer?: string;
	sources: SearchSource[];
}

export interface HeadlessSearchResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		response?: SearchResponse;
		error?: string;
	};
}

interface SearchOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	tavilyApiKey?: string | null;
}

const RECENCY_FILTER = { day: "d", week: "w", month: "m", year: "y" } as const;

function boundedLimit(params: SearchQueryParams): number {
	return Math.max(1, Math.min(20, Math.floor(params.num_search_results ?? params.limit ?? 8)));
}

function searchSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(20_000);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function decodeHtmlText(value: string): string {
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function unwrapDuckDuckGoUrl(value: string): string | undefined {
	const decoded = value.replace(/&amp;/gi, "&");
	const wrapped = /[?&]uddg=([^&]+)/.exec(decoded);
	if (wrapped) {
		try {
			return decodeURIComponent(wrapped[1]);
		} catch {
			return undefined;
		}
	}
	if (decoded.startsWith("//")) return `https:${decoded}`;
	return /^https?:\/\//.test(decoded) ? decoded : undefined;
}

function parseDuckDuckGoResults(html: string, limit: number): SearchSource[] {
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	const blockPattern =
		/<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
	const titlePattern = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
	const snippetPattern = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
	for (const match of html.matchAll(blockPattern)) {
		const title = titlePattern.exec(match[1]);
		if (!title) continue;
		const url = unwrapDuckDuckGoUrl(title[1]);
		if (!url || seen.has(url)) continue;
		const text = decodeHtmlText(title[2]);
		if (!text) continue;
		const snippet = snippetPattern.exec(match[1]);
		seen.add(url);
		sources.push({
			title: text,
			url,
			snippet: snippet ? decodeHtmlText(snippet[1]) || undefined : undefined,
		});
		if (sources.length >= limit) break;
	}
	return sources;
}

async function searchTavily(
	params: SearchQueryParams,
	apiKey: string,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const response = await fetchImpl("https://api.tavily.com/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			query: params.query,
			search_depth: "basic",
			max_results: boundedLimit(params),
			include_answer: "advanced",
			include_raw_content: false,
			...(params.recency ? { time_range: params.recency } : {}),
		}),
		signal: searchSignal(signal),
	});
	if (!response.ok) throw new Error(`Tavily HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
	const data = await response.json() as {
		answer?: string | null;
		results?: Array<{ title?: string | null; url?: string | null; content?: string | null; published_date?: string | null }>;
	};
	const sources = (data.results ?? []).flatMap(item => item.url ? [{
		title: item.title || item.url,
		url: item.url,
		snippet: item.content || undefined,
		publishedDate: item.published_date || undefined,
	}] : []).slice(0, boundedLimit(params));
	if (!data.answer?.trim() && !sources.length) throw new Error("Tavily 没有返回可用结果");
	return { provider: "tavily", answer: data.answer?.trim() || undefined, sources };
}

async function searchDuckDuckGo(
	params: SearchQueryParams,
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const form = new URLSearchParams({ q: params.query, kl: "us-en", b: "" });
	if (params.recency) form.set("df", RECENCY_FILTER[params.recency]);
	const response = await fetchImpl("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "Mozilla/5.0 (compatible; YeYu/1.0; +https://github.com/rtiy1/YeMuAINoval)",
		},
		body: form.toString(),
		signal: searchSignal(signal),
	});
	const html = await response.text();
	if (!response.ok) throw new Error(`DuckDuckGo HTTP ${response.status}`);
	if (html.includes("anomaly-modal") || html.includes("anomaly.js")) throw new Error("DuckDuckGo 返回了反自动化验证");
	const sources = parseDuckDuckGoResults(html, boundedLimit(params));
	if (!sources.length) throw new Error("DuckDuckGo 没有返回可用结果");
	return { provider: "duckduckgo", sources };
}

function formatForModel(response: SearchResponse): string {
	const lines: string[] = [];
	if (response.answer) lines.push(response.answer);
	if (response.sources.length) lines.push("## Sources");
	for (const [index, source] of response.sources.entries()) {
		lines.push(`[${index + 1}] ${source.title}${source.publishedDate ? ` (${source.publishedDate})` : ""}`);
		lines.push(`    ${source.url}`);
		if (source.snippet) lines.push(`    ${source.snippet.slice(0, 320)}`);
	}
	return lines.join("\n");
}

export async function runSearchQuery(
	params: SearchQueryParams,
	options: SearchOptions = {},
): Promise<HeadlessSearchResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const tavilyKey = options.tavilyApiKey === undefined ? Bun.env.TAVILY_API_KEY?.trim() : options.tavilyApiKey?.trim();
	const failures: string[] = [];
	if (tavilyKey) {
		try {
			const response = await searchTavily(params, tavilyKey, fetchImpl, options.signal);
			return { content: [{ type: "text", text: formatForModel(response) }], details: { response } };
		} catch (error) {
			if (options.signal?.aborted) throw error;
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	try {
		const response = await searchDuckDuckGo(params, fetchImpl, options.signal);
		return { content: [{ type: "text", text: formatForModel(response) }], details: { response } };
	} catch (error) {
		if (options.signal?.aborted) throw error;
		failures.push(error instanceof Error ? error.message : String(error));
	}
	const message = `联网搜索失败：${failures.join("；") || "没有可用搜索提供商"}`;
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: { response: { provider: "none", sources: [] }, error: message },
	};
}
