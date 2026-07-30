import packageJson from "../../package.json" with { type: "json" };

export function getOpenRouterHeaders(): Record<string, string> {
	return {
		"User-Agent": `Oh-My-YeMu/${packageJson.version}`,
		"HTTP-Referer": "https://github.com/rtiy1/YeMuAINoval/",
		"X-OpenRouter-Title": "Oh-My-YeMu",
		"X-OpenRouter-Categories": "cli-agent",
		"X-OpenRouter-Cache": "true",
		"X-OpenRouter-Cache-TTL": "3600",
	};
}
