import { describe, expect, it } from "bun:test";
import { Settings } from "@yemu/agent-runtime/config/settings";
import { loadYeMuMemoryConfig } from "@yemu/agent-runtime/yemu-memory/config";

// `yemu-memory.embeddingVariant` selects the concrete local embedding model, while an
// explicit `yemu-memory.embeddingModel` is an advanced override that wins. Scoping is
// pinned to "global" so the resolver stays pure (no legacy-bank disk probing).
function embeddingModelFor(overrides: Record<string, unknown>): string | undefined {
	const settings = Settings.isolated({ "yemu-memory.scoping": "global", ...overrides });
	return loadYeMuMemoryConfig(settings, "/tmp/yemu-memory-embedding-variant-test").providerOptions.embeddingModel;
}

describe("loadYeMuMemoryConfig embedding variant resolution", () => {
	it("maps the en variant to BAAI/bge-base-en-v1.5", () => {
		expect(embeddingModelFor({ "yemu-memory.embeddingVariant": "en" })).toBe("BAAI/bge-base-en-v1.5");
	});

	it("maps the multilingual variant to intfloat/multilingual-e5-large", () => {
		expect(embeddingModelFor({ "yemu-memory.embeddingVariant": "multilingual" })).toBe(
			"intfloat/multilingual-e5-large",
		);
	});

	it("lets an explicit embeddingModel override win over the variant", () => {
		expect(
			embeddingModelFor({
				"yemu-memory.embeddingVariant": "multilingual",
				"yemu-memory.embeddingModel": "openai/text-embedding-3-small",
			}),
		).toBe("openai/text-embedding-3-small");
	});

	it("ignores a blank override and falls back to the variant", () => {
		expect(embeddingModelFor({ "yemu-memory.embeddingVariant": "en", "yemu-memory.embeddingModel": "   " })).toBe(
			"BAAI/bge-base-en-v1.5",
		);
	});

	it("honors YEMU_MEMORY_EMBEDDING_MODEL when no explicit model setting is present", () => {
		const previous = Bun.env.YEMU_MEMORY_EMBEDDING_MODEL;
		Bun.env.YEMU_MEMORY_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			// The documented env override must not be shadowed by the variant default.
			expect(embeddingModelFor({ "yemu-memory.embeddingVariant": "en" })).toBe("BAAI/bge-large-en-v1.5");
		} finally {
			if (previous === undefined) delete Bun.env.YEMU_MEMORY_EMBEDDING_MODEL;
			else Bun.env.YEMU_MEMORY_EMBEDDING_MODEL = previous;
		}
	});

	it("lets an explicit embeddingModel setting win over the env var", () => {
		const previous = Bun.env.YEMU_MEMORY_EMBEDDING_MODEL;
		Bun.env.YEMU_MEMORY_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			expect(embeddingModelFor({ "yemu-memory.embeddingModel": "openai/text-embedding-3-small" })).toBe(
				"openai/text-embedding-3-small",
			);
		} finally {
			if (previous === undefined) delete Bun.env.YEMU_MEMORY_EMBEDDING_MODEL;
			else Bun.env.YEMU_MEMORY_EMBEDDING_MODEL = previous;
		}
	});
});
