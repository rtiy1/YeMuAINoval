import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@yemu/agent-core";
import { ModelRegistry } from "@yemu/agent-runtime/config/model-registry";
import { Settings } from "@yemu/agent-runtime/config/settings";
import { AgentSession } from "@yemu/agent-runtime/session/agent-session";
import { AuthStorage } from "@yemu/agent-runtime/session/auth-storage";
import { SessionManager } from "@yemu/agent-runtime/session/session-manager";
import type { AssistantMessage, UserMessage } from "@yemu/model-runtime";
import { TempDir } from "@yemu/utils";

describe("AgentSession session stats", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@yemu-session-stats-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	it("includes context usage available from the active session", () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model?.contextWindow) {
			throw new Error("Expected bundled model with a context window");
		}

		const userMessage: UserMessage = {
			role: "user",
			content: "Hello",
			timestamp: Date.now(),
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [userMessage, assistantMessage],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const directUsage = session.getContextUsage();
		const stats = session.getSessionStats();

		expect(directUsage).toEqual({
			tokens: 10,
			contextWindow: model.contextWindow,
			percent: (10 / model.contextWindow) * 100,
		});
		expect(stats.contextUsage).toEqual(directUsage);
	});
});
