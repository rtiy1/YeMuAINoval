import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleToolCall, TOOLS } from "@yemu/memory/mcp-tools";

let dataDir: string;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "yemu-memory-provider-tools-"));
	process.env.YEMU_MEMORY_DATA_DIR = dataDir;
	process.env.YEMU_MEMORY_NO_EMBEDDINGS = "1";
	delete process.env.YEMU_MEMORY_MCP_BANK;
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	delete process.env.YEMU_MEMORY_DATA_DIR;
	delete process.env.YEMU_MEMORY_NO_EMBEDDINGS;
	delete process.env.YEMU_MEMORY_MCP_BANK;
});

function toolNames(): Set<string> {
	return new Set(TOOLS.map(tool => tool.name));
}

describe("all provider-compatible MCP tools", () => {
	it("registers all 23 real tool names", () => {
		const names = toolNames();
		expect(names.size).toBe(23);
		for (const name of [
			"yemu-memory_remember",
			"yemu-memory_recall",
			"yemu-memory_sleep",
			"yemu-memory_stats",
			"yemu-memory_invalidate",
			"yemu-memory_validate",
			"yemu-memory_get",
			"yemu-memory_triple_add",
			"yemu-memory_triple_query",
			"yemu-memory_scratchpad_write",
			"yemu-memory_scratchpad_read",
			"yemu-memory_scratchpad_clear",
			"yemu-memory_export",
			"yemu-memory_update",
			"yemu-memory_forget",
			"yemu-memory_import",
			"yemu-memory_diagnose",
			"yemu-memory_shared_remember",
			"yemu-memory_shared_recall",
			"yemu-memory_shared_forget",
			"yemu-memory_shared_stats",
			"yemu-memory_graph_query",
			"yemu-memory_graph_link",
		]) {
			expect(names.has(name)).toBe(true);
		}
	});

	it("rejects unknown tools", async () => {
		await expect(handleToolCall("yemu-memory_nonexistent", {})).rejects.toThrow("Unknown tool");
	});
});

describe("representative provider-compatible handlers", () => {
	it("stores, recalls, reads stats, updates, gets, invalidates, and forgets", async () => {
		const remembered = await handleToolCall("yemu-memory_remember", {
			content: "Provider handler stores durable espresso preference",
			importance: 0.7,
			bank: "provider",
		});
		const memoryId = remembered.memory_id as string;
		expect(remembered.status).toBe("stored");
		expect(memoryId).toHaveLength(16);

		const recalled = await handleToolCall("yemu-memory_recall", {
			query: "espresso preference",
			limit: 5,
			bank: "provider",
		});
		expect(recalled.status).toBe("ok");
		expect(recalled.count as number).toBeGreaterThanOrEqual(1);

		const updated = await handleToolCall("yemu-memory_update", {
			memory_id: memoryId,
			content: "Provider handler stores durable tea preference",
			bank: "provider",
		});
		expect(updated.status).toBe("updated");
		const got = await handleToolCall("yemu-memory_get", { memory_id: memoryId, bank: "provider" });
		expect(got.status).toBe("ok");
		expect(JSON.stringify(got.memory)).toContain("tea preference");

		const stats = await handleToolCall("yemu-memory_stats", { bank: "provider" });
		expect(stats.status).toBe("ok");
		expect(stats.working).toBeDefined();

		const invalidated = await handleToolCall("yemu-memory_invalidate", {
			memory_id: memoryId,
			bank: "provider",
		});
		expect(invalidated.status).toBe("invalidated");
		const forgotten = await handleToolCall("yemu-memory_forget", { memory_id: memoryId, bank: "provider" });
		expect(forgotten.status).toBe("deleted");
	});

	it("handles sleep and scratchpad operations", async () => {
		const write = await handleToolCall("yemu-memory_scratchpad_write", {
			content: "provider scratch",
			bank: "provider",
		});
		expect(write.status).toBe("written");
		const read = await handleToolCall("yemu-memory_scratchpad_read", { bank: "provider" });
		expect(read.entries_count as number).toBe(1);
		const clear = await handleToolCall("yemu-memory_scratchpad_clear", { bank: "provider" });
		expect(clear.status).toBe("cleared");
		const sleep = await handleToolCall("yemu-memory_sleep", { dry_run: true, bank: "provider" });
		expect(sleep.status).toBe("ok");
		expect(sleep.dry_run).toBe(true);
	});

	it("handles bank-isolated operations", async () => {
		await handleToolCall("yemu-memory_remember", {
			content: "only alpha bank contains apricot",
			bank: "alpha",
		});
		const alpha = await handleToolCall("yemu-memory_recall", { query: "apricot", bank: "alpha" });
		const beta = await handleToolCall("yemu-memory_recall", { query: "apricot", bank: "beta" });
		expect(alpha.count as number).toBeGreaterThanOrEqual(1);
		expect(beta.count).toBe(0);
	});

	it("handles triple and shared-surface tools", async () => {
		const triple = await handleToolCall("yemu-memory_triple_add", {
			subject: "user",
			predicate: "prefers",
			object: "oolong",
			bank: "provider",
		});
		expect(triple.status).toBe("stored");
		const triples = await handleToolCall("yemu-memory_triple_query", {
			subject: "user",
			predicate: "prefers",
			bank: "provider",
		});
		expect(triples.results_count as number).toBeGreaterThanOrEqual(1);

		const shared = await handleToolCall("yemu-memory_shared_remember", {
			content: "User prefers concise answers",
			kind: "preference",
		});
		expect(shared.status).toBe("stored_shared");
		const sharedRecall = await handleToolCall("yemu-memory_shared_recall", { query: "concise answers" });
		expect(sharedRecall.count as number).toBeGreaterThanOrEqual(1);
		const sharedStats = await handleToolCall("yemu-memory_shared_stats", {});
		expect(sharedStats.provider).toBe("yemu-memory_shared");
	});
});
