import { expect, test } from "bun:test";
import { runSearchQuery } from "./web-search-runtime";

function fetchMock(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
	return Object.assign(handler, { preconnect: globalThis.fetch.preconnect });
}

test("headless web search uses Tavily without loading TUI modules", async () => {
	let requestBody: Record<string, unknown> | null = null;
	const result = await runSearchQuery({ query: "宋代夜市", limit: 3 }, {
		tavilyApiKey: "test-tavily-key",
		fetchImpl: fetchMock(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
			return Response.json({
				answer: "宋代城市夜市较为繁荣。",
				results: [{ title: "宋代夜市资料", url: "https://example.test/tavily", content: "公开资料摘要" }],
			});
		}),
	});

	expect(requestBody?.query).toBe("宋代夜市");
	expect(result.details.response?.provider).toBe("tavily");
	expect(result.content[0]?.text).toContain("https://example.test/tavily");
});

test("headless web search falls back from Tavily to DuckDuckGo", async () => {
	const urls: string[] = [];
	const result = await runSearchQuery({ query: "古代驿站", recency: "year" }, {
		tavilyApiKey: "broken-key",
		fetchImpl: fetchMock(async (input) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("tavily.com")) return new Response("upstream unavailable", { status: 503 });
			return new Response([
				'<div class="result results_links">',
				'<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.test%2Fddg">古代驿站制度</a>',
				'<a class="result__snippet">驿站用于传递公文与接待官员。</a>',
				'</div><div class="nav-link"></div>',
			].join(""), { status: 200, headers: { "content-type": "text/html" } });
		}),
	});

	expect(urls).toHaveLength(2);
	expect(result.details.response?.provider).toBe("duckduckgo");
	expect(result.content[0]?.text).toContain("https://example.test/ddg");
});
