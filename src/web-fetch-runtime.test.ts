import { expect, test } from "bun:test";
import { isPublicWebAddress, runWebFetch } from "./web-fetch-runtime";

const publicLookup = async (): Promise<Array<{ address: string; family: number }>> => [
	{ address: "93.184.216.34", family: 4 },
];

function fetchMock(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
	return Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
}

test("web fetch extracts readable Markdown from a public HTML page", async () => {
	const result = await runWebFetch({
		url: "https://example.com/story",
		prompt: "提取时代背景",
	}, {
		lookupImpl: publicLookup,
		fetchImpl: fetchMock(async () => new Response(`<!doctype html>
			<html><head><title>宋代夜市</title></head><body>
			<nav>导航</nav><article><h1>宋代夜市</h1><p>夜市可以营业至三更前后。</p></article>
			</body></html>`, {
			status: 200,
			headers: { "content-type": "text/html; charset=utf-8" },
		})),
	});

	expect(result.details.title).toContain("宋代夜市");
	expect(result.content[0]?.text).toContain("夜市可以营业");
	expect(result.content[0]?.text).toContain("Source: https://example.com/story");
	expect(result.content[0]?.text).toContain("Fetch focus: 提取时代背景");
});

test("web fetch validates every redirect target", async () => {
	const urls: string[] = [];
	const result = await runWebFetch({ url: "https://example.com/start" }, {
		lookupImpl: publicLookup,
		fetchImpl: fetchMock(async (input) => {
			urls.push(String(input));
			if (urls.length === 1) {
				return new Response(null, { status: 302, headers: { location: "https://www.example.com/final" } });
			}
			return new Response("final text", { status: 200, headers: { "content-type": "text/plain" } });
		}),
	});

	expect(urls).toHaveLength(2);
	expect(result.details.finalUrl).toBe("https://www.example.com/final");
	expect(result.details.redirects).toBe(1);
});

test("web fetch blocks private, metadata, and reserved network targets", async () => {
	expect(isPublicWebAddress("8.8.8.8")).toBe(true);
	expect(isPublicWebAddress("127.0.0.1")).toBe(false);
	expect(isPublicWebAddress("169.254.169.254")).toBe(false);
	expect(isPublicWebAddress("::1")).toBe(false);
	expect(isPublicWebAddress("2606:4700:4700::1111")).toBe(true);

	await expect(runWebFetch({ url: "http://127.0.0.1/admin" })).rejects.toThrow("内网或保留 IP");
	await expect(runWebFetch({ url: "https://metadata.example.com/latest" }, {
		lookupImpl: async () => [{ address: "169.254.169.254", family: 4 }],
	})).rejects.toThrow("未解析到可公开访问的 IP");
});

test("web fetch rejects oversized and binary responses", async () => {
	await expect(runWebFetch({ url: "https://example.com/large" }, {
		lookupImpl: publicLookup,
		fetchImpl: fetchMock(async () => new Response("small", {
			headers: { "content-type": "text/plain", "content-length": String(3 * 1024 * 1024) },
		})),
	})).rejects.toThrow("2 MB");

	await expect(runWebFetch({ url: "https://example.com/file.pdf" }, {
		lookupImpl: publicLookup,
		fetchImpl: fetchMock(async () => new Response("%PDF", {
			headers: { "content-type": "application/pdf" },
		})),
	})).rejects.toThrow("暂不支持的网页类型");
});
