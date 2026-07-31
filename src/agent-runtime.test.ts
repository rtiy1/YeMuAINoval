import { expect, spyOn, test } from "bun:test";
import { STORY_AGENT_RUNTIME_INFO, listStorySkills, runStoryAgent } from "./agent-runtime";

function deepSeekSseResponse(text: string): Response {
	const events = [
		{
			id: "chatcmpl-yemu-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
			usage: null,
		},
		{
			id: "chatcmpl-yemu-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
			usage: {
				prompt_tokens: 20,
				completion_tokens: 2,
				total_tokens: 22,
				prompt_cache_hit_tokens: 0,
				prompt_cache_miss_tokens: 20,
			},
		},
		"[DONE]",
	];
	const body = `${events
		.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`)
		.join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

test("web agent runtime discovers Story Skills and validates model credentials", async () => {
	const previousOpenAIKey = Bun.env.OPENAI_API_KEY;
	const previousAnthropicKey = Bun.env.ANTHROPIC_API_KEY;
	Bun.env.OPENAI_API_KEY = "";
	Bun.env.ANTHROPIC_API_KEY = "";
	try {
		expect(STORY_AGENT_RUNTIME_INFO).toEqual({
			id: "yemu-agent-runtime",
			protocolVersion: 1,
			execution: "in-process",
		});
		const skills = await listStorySkills();
		expect(skills.length).toBeGreaterThanOrEqual(10);
		expect(skills.every(skill => skill.executor === "yemu-agent-runtime")).toBe(true);
		await expect(
			runStoryAgent({
				message: "写一个短篇",
				skill: "story-short-write",
				model_config: { provider: "openai", api_key: "" },
			}),
		).rejects.toThrow("API Key");
	} finally {
		if (previousOpenAIKey === undefined) delete Bun.env.OPENAI_API_KEY;
		else Bun.env.OPENAI_API_KEY = previousOpenAIKey;
		if (previousAnthropicKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
		else Bun.env.ANTHROPIC_API_KEY = previousAnthropicKey;
	}
});

test("DeepSeek-compatible settings use system messages and preserve upstream errors", async () => {
	let capturedPayload: Record<string, unknown> | null = null;
	const successFetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			capturedPayload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return deepSeekSseResponse("正常");
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const successSpy = spyOn(globalThis, "fetch").mockImplementation(successFetch);
	try {
		const response = await runStoryAgent({
			message: "回答正常",
			skill: "story-setup",
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
				reasoning_effort: "high",
			},
		});
		expect(response.result.output).toBe("正常");
		const messages = capturedPayload?.messages;
		expect(Array.isArray(messages) ? messages[0]?.role : null).toBe("system");
	} finally {
		successSpy.mockRestore();
	}

	const failureFetch = Object.assign(
		async (): Promise<Response> =>
			new Response(
				JSON.stringify({ error: { message: "synthetic upstream failure", type: "invalid_request_error" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			),
		{ preconnect: globalThis.fetch.preconnect },
	);
	const failureSpy = spyOn(globalThis, "fetch").mockImplementation(failureFetch);
	try {
		await expect(
			runStoryAgent({
				message: "触发错误",
				skill: "story-setup",
				model_config: {
					provider: "openai",
					api_base_url: "https://api.deepseek.com/v1",
					api_key: "test-key",
					model: "deepseek-v4-flash",
					reasoning_effort: "high",
				},
			}),
		).rejects.toThrow("synthetic upstream failure");
	} finally {
		failureSpy.mockRestore();
	}
});
