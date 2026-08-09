import { expect, spyOn, test } from "bun:test";
import {
	estimateWebTextTokens,
	STORY_AGENT_RUNTIME_INFO,
	listStorySkills,
	runStoryAgent,
	storyAgentModelCapabilities,
} from "./agent-runtime";

test("Web prompt token estimation stays lightweight and handles CJK text", () => {
	expect(estimateWebTextTokens("一二三四")).toBe(4);
	expect(estimateWebTextTokens("12345678")).toBe(2);
	expect(estimateWebTextTokens("小说 draft")).toBe(4);
});

test("Web reasoning controls follow the TUI model capability ladder", () => {
	const deepSeekLow = storyAgentModelCapabilities({
		provider: "openai",
		api_base_url: "https://api.deepseek.com/v1",
		model: "deepseek-v4-flash",
		reasoning_effort: "low",
	});
	expect(deepSeekLow.reasoning).toBe(true);
	expect(deepSeekLow.supportedEfforts).toEqual(["high", "max"]);
	expect(deepSeekLow.effectiveEffort).toBe("high");
	expect(deepSeekLow.maxTokens).toBe(128_000);

	const deepSeekOff = storyAgentModelCapabilities({
		provider: "openai",
		api_base_url: "https://api.deepseek.com/v1",
		model: "deepseek-v4-flash",
		reasoning_effort: "off",
	});
	expect(deepSeekOff.disableReasoning).toBe(true);
	expect(deepSeekOff.effectiveEffort).toBeUndefined();

	const claudeMinimal = storyAgentModelCapabilities({
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		reasoning_effort: "minimal",
	});
	expect(claudeMinimal.reasoning).toBe(true);
	expect(claudeMinimal.effectiveEffort).toBe("minimal");
	expect(claudeMinimal.disableReasoning).toBe(false);

	const nonReasoning = storyAgentModelCapabilities({
		provider: "openai",
		model: "gpt-4o-mini",
		reasoning_effort: "high",
	});
	expect(nonReasoning.reasoning).toBe(false);
	expect(nonReasoning.supportedEfforts).toEqual([]);
	expect(nonReasoning.effectiveEffort).toBeUndefined();
});

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

function deepSeekReasoningLimitResponse(reasoning: string): Response {
	const events = [
		{
			id: "chatcmpl-yemu-length-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning }, finish_reason: null }],
			usage: null,
		},
		{
			id: "chatcmpl-yemu-length-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{ index: 0, delta: { content: "" }, finish_reason: "length" }],
			usage: {
				prompt_tokens: 20,
				completion_tokens: 4096,
				total_tokens: 4116,
				completion_tokens_details: { reasoning_tokens: 4096 },
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

function deepSeekReasoningToolSseResponse(
	reasoning: string,
	id: string,
	name: string,
	args: Record<string, unknown>,
): Response {
	const events = [
		{
			id: "chatcmpl-yemu-reasoning-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning }, finish_reason: null }],
			usage: null,
		},
		{
			id: "chatcmpl-yemu-reasoning-tool-test",
			object: "chat.completion.chunk",
			created: 0,
			model: "deepseek-v4-flash",
			choices: [{
				index: 0,
				delta: {
					tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
				},
				finish_reason: null,
			}],
			usage: null,
		},
		{
			id: "chatcmpl-yemu-reasoning-tool-test",
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

function providerErrorResponse(status: number, message: string): Response {
	return new Response(
		JSON.stringify({ error: { message, type: "server_error" } }),
		{ status, headers: { "content-type": "application/json" } },
	);
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
				reasoning_effort: "low",
			},
		});
		expect(response.result.output).toBe("正常");
		expect(capturedPayload?.reasoning_effort).toBe("high");
		const messages = capturedPayload?.messages;
		expect(Array.isArray(messages) ? messages[0]?.role : null).toBe("system");
		expect(JSON.stringify(Array.isArray(messages) ? messages[0] : null)).toContain(
			"隐藏思考只用于确定“下一次动作”",
		);
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

test("reasoning-only length stops automatically continue to a visible answer", async () => {
	const responses = [
		deepSeekReasoningLimitResponse("先完整分析问题，但这一轮的额度只够思考。"),
		deepSeekSseResponse("这是自动续跑后提交的最终答复。"),
	];
	const reasoningDeltas: string[] = [];
	const textDeltas: string[] = [];
	const textMessageIds: string[] = [];
	const payloads: Array<Record<string, unknown>> = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payloads.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
			return responses[calls++] ?? deepSeekSseResponse("完成");
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "完成一个需要深入推理的创作任务",
			skill: "story-setup",
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
				reasoning_effort: "high",
				max_tokens: 4096,
			},
		}, {
			onReasoningDelta: (delta) => reasoningDeltas.push(delta),
			onDelta: (delta, context) => {
				textDeltas.push(delta);
				textMessageIds.push(context.messageId);
			},
		});

		expect(calls).toBe(2);
		expect(reasoningDeltas.join("")).toContain("这一轮的额度只够思考");
		expect(textDeltas.join("")).toBe("这是自动续跑后提交的最终答复。");
		expect(textMessageIds).toEqual(["assistant-2"]);
		expect(response.result.output).toBe("这是自动续跑后提交的最终答复。");
		expect(payloads[1]?.reasoning_effort).toBe("high");
		const recoveryMessages = payloads[1]?.messages;
		expect(JSON.stringify(recoveryMessages)).toContain("系统续跑");
	} finally {
		fetchSpy.mockRestore();
	}
});

test("assistant message boundaries preserve reasoning-tool-reasoning order", async () => {
	const responses = [
		deepSeekReasoningToolSseResponse("先读取现有设定。", "call-read", "read_story_file", { path: "设定/世界.md" }),
		deepSeekReasoningToolSseResponse("读取完成，再提交结果。", "call-submit", "submit_story_result", {
			status: "completed",
			output: "大纲已完成。",
		}),
		deepSeekSseResponse("完成"),
	];
	const timeline: string[] = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (): Promise<Response> => responses[calls++] ?? deepSeekSseResponse("完成"),
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		await runStoryAgent({
			message: "读取设定后完成大纲",
			skill: "story-long-write",
			payload: { project_id: "project-1", tool_policy: { mutateStoryData: "propose" } },
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		}, {
			readStoryFile: async () => ({ path: "设定/世界.md", content: "既有世界设定" }),
			onAssistantMessageEvent: (event) => timeline.push(`${event.phase}:${event.messageId}`),
			onReasoningDelta: (delta, context) => timeline.push(`reasoning:${context.messageId}:${delta}`),
			onToolEvent: (event) => timeline.push(`tool:${event.phase}:${event.toolName}`),
		});
		expect(timeline).toEqual([
			"start:assistant-1",
			"reasoning:assistant-1:先读取现有设定。",
			"end:assistant-1",
			"tool:start:read_story_file",
			"tool:end:read_story_file",
			"start:assistant-2",
			"reasoning:assistant-2:读取完成，再提交结果。",
			"end:assistant-2",
			"tool:start:submit_story_result",
			"tool:end:submit_story_result",
		]);
	} finally {
		fetchSpy.mockRestore();
	}
});

test("request-user-input terminates the model loop and streams complete questions", async () => {
	const responses = [
		deepSeekToolSseResponse("call-input-now", "request_user_input", {
			questions: [{
				id: "identity",
				header: "主角身份",
				question: "主角具体穿越成什么身份？",
				options: [
					{ label: "原创平民", description: "从零成长" },
					{ label: "木叶忍族", description: "拥有家族关系" },
				],
			}],
		}),
		deepSeekSseResponse("这段内容不应该在问题之后继续生成。"),
	];
	const toolEvents: Array<{
		phase: string;
		toolName: string;
		arguments: Record<string, unknown>;
	}> = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (): Promise<Response> => responses[calls++] ?? deepSeekSseResponse("不应继续"),
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "先确认主角身份再继续",
			skill: "story-long-write",
			payload: {},
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		}, {
			onToolEvent: event => toolEvents.push(event),
		});

		expect(calls).toBe(1);
		expect(response.status).toBe("needs_input");
		expect(response.result.question?.requestId).toBe("call-input-now");
		expect(response.result.question?.questions[0]?.question).toBe("主角具体穿越成什么身份？");
		const completedInput = toolEvents.find(event => event.phase === "end");
		expect(completedInput?.toolName).toBe("request_user_input");
		expect(completedInput?.arguments.questions).toEqual([{
			id: "identity",
			header: "主角身份",
			question: "主角具体穿越成什么身份？",
			options: [
				{ label: "原创平民", value: "原创平民", description: "从零成长" },
				{ label: "木叶忍族", value: "木叶忍族", description: "拥有家族关系" },
			],
		}]);
	} finally {
		fetchSpy.mockRestore();
	}
});

test("request-user-input cannot appear after the turn has started writing files", async () => {
	const responses = [
		deepSeekToolSseResponse("call-write-before-input", "write_story_file", {
			path: "设定/临时.md",
			content: "已经开始写入。",
		}),
		deepSeekToolSseResponse("call-late-input", "request_user_input", {
			questions: [{
				id: "late_direction",
				question: "现在再选择方向？",
				options: [{ label: "方向 A" }, { label: "方向 B" }],
			}],
		}),
		deepSeekToolSseResponse("call-submit-after-late-input", "submit_story_result", {
			status: "completed",
			output: "已按最小合理假设完成。",
		}),
	];
	const requestPayloads: Array<Record<string, unknown>> = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestPayloads.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
			return responses[calls++] ?? deepSeekSseResponse("不应继续");
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "继续完善当前方案",
			skill: "story-setup",
			payload: { tool_policy: { mutateStoryData: "propose" } },
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		});

		expect(calls).toBe(3);
		expect(response.status).toBe("completed");
		expect(response.result.question).toBeUndefined();
		expect(response.result.output).toBe("已按最小合理假设完成。");
		expect(JSON.stringify(requestPayloads[2]?.messages)).toContain("不能在交付完成后再弹出问题");
	} finally {
		fetchSpy.mockRestore();
	}
});

test("answered request-user-input topics are not asked again with different wording", async () => {
	const responses = [
		deepSeekToolSseResponse("call-repeat", "request_user_input", {
			questions: [{
				id: "protagonist_identity",
				header: "主角身份",
				question: "主角具体要穿越成谁？",
				options: [
					{ label: "原创角色", description: "与水门同期" },
					{ label: "水门本人", description: "改写四代目人生" },
				],
			}],
		}),
		deepSeekToolSseResponse("call-submit-after-repeat", "submit_story_result", {
			status: "completed",
			output: "沿用已有答案并按原创角色继续推进。",
		}),
		deepSeekSseResponse("完成"),
	];
	const requestPayloads: Array<Record<string, unknown>> = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestPayloads.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
			return responses[calls++] ?? deepSeekSseResponse("完成");
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "继续完成火影同人开书方案",
			skill: "story-long-write",
			payload: {
				request_user_input_history: [{
					questions: [{
						id: "identity_timeline",
						header: "穿越身份与时间线",
						question: "主角穿越成谁、从哪个时间点开始？",
					}],
					response: {
						answers: { identity_timeline: { answers: ["从水门那一代开始"] } },
						answerText: "穿越身份与时间线：从水门那一代开始",
					},
				}],
			},
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		});

		expect(response.status).toBe("completed");
		expect(response.result.question).toBeUndefined();
		expect(response.result.output).toBe("沿用已有答案并按原创角色继续推进。");
		expect(JSON.stringify(requestPayloads[1]?.messages)).toContain("不要换一种说法重复提问");
	} finally {
		fetchSpy.mockRestore();
	}
});

test("writing skills keep their route while only the CLI-style web fetch tool is enabled", async () => {
	const responses = [
		deepSeekToolSseResponse("call-fetch", "web_fetch", {
			url: "https://example.com/song-night-market",
			prompt: "核对营业时间",
		}),
		deepSeekToolSseResponse("call-submit-search", "submit_story_result", {
			status: "completed",
			output: "已结合网页资料给出写作建议。",
		}),
		deepSeekSseResponse("完成"),
	];
	const fetchedUrls: string[] = [];
	const requestPayloads: Array<Record<string, unknown>> = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			requestPayloads.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
			return responses[calls++] ?? deepSeekSseResponse("完成");
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "续写夜市场景，并核对宋代夜市资料",
			skill: "story-long-write",
			payload: { web_fetch: true, tool_policy: { mutateStoryData: "propose" } },
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		}, {
			fetchWeb: async (params) => {
				fetchedUrls.push(params.url);
				return {
					content: [{ type: "text", text: "Source: https://example.com/song-night-market\n\n夜市可营业至三更。" }],
					details: {
						url: params.url,
						finalUrl: params.url,
						status: 200,
						contentType: "text/html",
						bytes: 32,
						chars: 24,
						redirects: 0,
						truncated: false,
					},
				};
			},
		});
		expect(response.selected_skill).toBe("story-long-write");
		expect(response.result.output).toBe("已结合网页资料给出写作建议。");
		expect(fetchedUrls).toEqual(["https://example.com/song-night-market"]);
		const firstTools = Array.isArray(requestPayloads[0]?.tools) ? requestPayloads[0].tools : [];
		expect(firstTools.map(tool => tool?.function?.name ?? tool?.name)).toContain("web_fetch");
		expect(firstTools.map(tool => tool?.function?.name ?? tool?.name)).not.toContain("web_search");
		expect(JSON.stringify(requestPayloads[1]?.messages)).toContain("夜市可营业至三更");
	} finally {
		fetchSpy.mockRestore();
	}
});

test("transient provider failures retry once without replaying visible output", async () => {
	const responses = [
		providerErrorResponse(503, "Service temporarily unavailable"),
		deepSeekSseResponse("自动重试后完成。"),
	];
	const deltas: string[] = [];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (): Promise<Response> => responses[calls++] ?? deepSeekSseResponse("完成"),
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "分析这个开场",
			skill: "story-long-analyze",
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
			},
		}, { onDelta: delta => deltas.push(delta) });
		expect(calls).toBe(2);
		expect(deltas.join("")).toBe("自动重试后完成。");
		expect(response.result.output).toBe("自动重试后完成。");
	} finally {
		fetchSpy.mockRestore();
	}
});

test("context overflow compacts the active Web turn and continues", async () => {
	const payloadBodies: string[] = [];
	const responses = [
		providerErrorResponse(400, "This model's maximum context length is 128000 tokens, but the request is too large."),
		deepSeekSseResponse("压缩上下文后已继续完成。"),
	];
	let calls = 0;
	const mockedFetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payloadBodies.push(typeof init?.body === "string" ? init.body : "");
			return responses[calls++] ?? deepSeekSseResponse("完成");
		},
		{ preconnect: globalThis.fetch.preconnect },
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockedFetch);
	try {
		const response = await runStoryAgent({
			message: "根据附件分析并续写",
			skill: "story-long-write",
			payload: {
				attached_files: [
					{ name: "资料一.md", content: "甲".repeat(30_000) },
					{ name: "资料二.md", content: "乙".repeat(30_000) },
				],
				conversation: Array.from({ length: 12 }, (_, index) => ({ role: "user", text: `旧消息${index}：${"丙".repeat(2_000)}` })),
			},
			model_config: {
				provider: "openai",
				api_base_url: "https://api.deepseek.com/v1",
				api_key: "test-key",
				model: "deepseek-v4-flash",
				context_window: 128_000,
			},
		});
		expect(calls).toBe(2);
		expect(response.result.output).toBe("压缩上下文后已继续完成。");
		expect(payloadBodies[1]?.length).toBeLessThan(payloadBodies[0]?.length ?? 0);
		expect(payloadBodies[1]).toContain("上下文压缩省略");
	} finally {
		fetchSpy.mockRestore();
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
			content: {
				title: "旧港",
				sections: [
					{ heading: "灯塔", content: "每晚会闪烁三次。" },
					{ heading: "码头", content: "汽笛声只在雾天出现。" },
				],
			},
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
		expect(calls).toBe(3);
		expect(documents.map(file => file.path)).toEqual(["设定/人物.md", "设定/地点.md"]);
		expect(documents[0]?.content).toBe("林默，失踪记者。");
		expect(documents[1]?.content).toContain("# 旧港");
		expect(documents[1]?.content).toContain("## 灯塔\n\n每晚会闪烁三次。");
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
