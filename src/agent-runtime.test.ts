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

function deepSeekToolSseResponse(id: string, name: string, args: Record<string, unknown>): Response {
	const events = [
		{
			id: "chatcmpl-yemu-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{
				index: 0,
				delta: {
					role: "assistant",
					tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
				},
				finish_reason: null,
			}],
			usage: null,
		},
		{
			id: "chatcmpl-yemu-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
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
			payload: { tool_policy: { mutateStoryData: "propose" } },
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
		const tools = Array.isArray(capturedPayload?.tools) ? capturedPayload.tools : [];
		const toolNames = tools.map(tool => tool?.function?.name ?? tool?.name);
		expect(toolNames).toContain("list_story_files");
		expect(toolNames).toContain("read_story_file");
		expect(toolNames).toContain("write_story_file");
		expect(toolNames).toContain("edit_story_file");
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

test("Story Agent can write multiple virtual files across independent tool turns", async () => {
	const responses = [
		deepSeekToolSseResponse("call-write-1", "write_story_file", {
			path: "设定/人物.md",
			title: "人物",
			category: "设定",
			content: "林默，失踪记者。",
		}),
		deepSeekToolSseResponse("call-write-2", "write_story_file", {
			path: "设定/地点.md",
			title: "地点",
			category: "设定",
			content: "旧港灯塔。",
		}),
		deepSeekToolSseResponse("call-submit", "submit_story_result", {
			status: "completed",
			output: "已创建两份设定文件。",
		}),
		deepSeekSseResponse("完成"),
	];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (): Promise<Response> => responses[calls++] ?? deepSeekSseResponse("完成"),
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "分别创建人物和地点文件",
			skill: "story-setup",
			payload: { tool_policy: { mutateStoryData: "propose" } },
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		});
		const documents = response.result.artifacts?.documents as Array<{ path: string; content: string }>;
		expect(calls).toBe(4);
		expect(documents.map(file => file.path)).toEqual(["设定/人物.md", "设定/地点.md"]);
		expect(documents[0]?.content).toBe("林默，失踪记者。");
		expect(response.result.output).toBe("已创建两份设定文件。");
	} finally {
		fetchSpy.mockRestore();
	}
});

test("file requests are corrected when the model only describes a plan", async () => {
	const responses = [
		deepSeekSseResponse("我会创建设定文件。"),
		deepSeekToolSseResponse("call-forced-write", "write_story_file", {
			path: "设定/世界规则.md",
			title: "世界规则",
			category: "设定",
			content: "# 世界规则\n\n能力必须遵守等价交换。",
		}),
		deepSeekSseResponse("已创建 `设定/世界规则.md`。"),
	];
	const toolEvents: Array<{ phase: string; toolName: string }> = [];
	const persistedFiles: Array<{ path: string; content?: string }> = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (): Promise<Response> => responses[calls++] ?? deepSeekSseResponse("完成"),
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "确认",
			skill: "story-setup",
			payload: {
				tool_policy: { mutateStoryData: "allow" },
				conversation: [
					{ role: "user", text: "按方案补全世界设定" },
					{ role: "assistant", text: "是否确认创建这个文件？确认后进入 Phase 3。" },
				],
			},
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		}, {
			onToolEvent: (event) => toolEvents.push(event),
			writeStoryFile: (file) => persistedFiles.push(file),
		});
		const documents = response.result.artifacts?.documents as Array<{ path: string }>;
		expect(documents.map(file => file.path)).toEqual(["设定/世界规则.md"]);
		expect(persistedFiles.map(file => file.path)).toEqual(["设定/世界规则.md"]);
		expect(persistedFiles[0]?.content).toContain("能力必须遵守等价交换");
		expect(toolEvents.map(event => `${event.phase}:${event.toolName}`)).toEqual([
			"start:write_story_file",
			"end:write_story_file",
		]);
	} finally {
		fetchSpy.mockRestore();
	}
});
