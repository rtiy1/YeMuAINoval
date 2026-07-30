import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@yemu/agent-core";
import { AsyncJobManager } from "@yemu/agent-runtime/async";
import { ModelRegistry } from "@yemu/agent-runtime/config/model-registry";
import { Settings } from "@yemu/agent-runtime/config/settings";
import { HindsightSessionState } from "@yemu/agent-runtime/hindsight/state";
import { AgentSession } from "@yemu/agent-runtime/session/agent-session";
import { AuthStorage } from "@yemu/agent-runtime/session/auth-storage";
import { SessionManager } from "@yemu/agent-runtime/session/session-manager";
import { setYeMuMemorySessionState, YeMuMemorySessionState } from "@yemu/agent-runtime/yemu-memory/state";
import { getBundledModel } from "@yemu/model-catalog/models";
import { createMockModel } from "@yemu/model-runtime/providers/mock";
import { logger, TempDir } from "@yemu/utils";

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("AgentSession concurrent disposal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@yemu-dispose-concurrent-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		vi.useRealTimers();
		const current = session;
		session = undefined;
		if (current) await current.dispose();
		authStorage.close();
		AsyncJobManager.resetForTests();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	function createSession(ownedAsyncJobManager?: AsyncJobManager): AgentSession {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			ownedAsyncJobManager,
			agentId: "Main",
		});
		return session;
	}

	it("starts independent writers together and closes persistence after their barrier", async () => {
		const owned = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 1_000, onJobComplete: () => {} });
		const asyncGate = Promise.withResolvers<void>();
		const hindsightGate = Promise.withResolvers<void>();
		const yemuMemoryGate = Promise.withResolvers<void>();
		const asyncStarted = Promise.withResolvers<void>();
		const order: string[] = [];
		vi.spyOn(owned, "dispose").mockImplementation(async () => {
			order.push("async:start");
			asyncStarted.resolve();
			await asyncGate.promise;
			order.push("async:end");
			return true;
		});

		const current = createSession(owned);
		const hindsight: HindsightSessionState = Object.create(HindsightSessionState.prototype);
		vi.spyOn(hindsight, "flushRetainQueue").mockImplementation(async () => {
			order.push("hindsight:start");
			await hindsightGate.promise;
			order.push("hindsight:end");
		});
		vi.spyOn(hindsight, "dispose").mockImplementation(() => {});
		current.setHindsightSessionState(hindsight);

		const yemuMemory: YeMuMemorySessionState = Object.create(YeMuMemorySessionState.prototype);
		vi.spyOn(yemuMemory, "dispose").mockImplementation(async () => {
			order.push("yemu-memory:start");
			await yemuMemoryGate.promise;
			order.push("yemu-memory:end");
		});
		setYeMuMemorySessionState(current, yemuMemory);

		let persistenceClosed = false;
		vi.spyOn(current.sessionManager, "close").mockImplementation(async () => {
			persistenceClosed = true;
			order.push("session:close");
		});

		const dispose = current.dispose();
		try {
			await asyncStarted.promise;
			await Promise.resolve();
			expect(order).toContain("hindsight:start");
			expect(order).toContain("yemu-memory:start");
			expect(order).not.toContain("async:end");
			expect(order).not.toContain("hindsight:end");
			expect(order).not.toContain("yemu-memory:end");
			expect(persistenceClosed).toBe(false);
		} finally {
			asyncGate.resolve();
			hindsightGate.resolve();
			yemuMemoryGate.resolve();
		}
		await dispose;
		session = undefined;

		const closeAt = order.indexOf("session:close");
		expect(closeAt).toBeGreaterThan(order.indexOf("async:end"));
		expect(closeAt).toBeGreaterThan(order.indexOf("hindsight:end"));
		expect(closeAt).toBeGreaterThan(order.indexOf("yemu-memory:end"));
	});

	it("bounds post-prompt work that ignores abort", async () => {
		vi.useFakeTimers();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const current = createSession();
		const hangingTask = Promise.withResolvers<void>();
		current.trackPostPromptTaskForTests(hangingTask.promise);

		const dispose = current.dispose();
		await flushMicrotasks();
		vi.advanceTimersByTime(5_000);
		await flushMicrotasks();
		await dispose;
		session = undefined;

		expect(warn).toHaveBeenCalledWith(
			"Post-prompt tasks still draining at dispose deadline",
			expect.objectContaining({ error: "Error: Timed out draining post-prompt tasks during dispose" }),
		);
	});

	it("clears the owned async manager when its dispose rejects", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const owned = new AsyncJobManager({ maxRunningJobs: 1, retentionMs: 1_000, onJobComplete: () => {} });
		vi.spyOn(owned, "dispose").mockRejectedValue(new Error("async dispose failed"));
		AsyncJobManager.setInstance(owned);
		const current = createSession(owned);

		await current.dispose();
		session = undefined;

		expect(AsyncJobManager.instance()).toBeUndefined();
		expect(warn).toHaveBeenCalledWith("Session dispose subsystem failed during parallel teardown", {
			error: "Error: async dispose failed",
		});
	});
});
