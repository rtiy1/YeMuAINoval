import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, ApiKey, Model } from "@yemu/model-runtime";

export interface YeMuMemoryLlmCompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
}

export type YeMuMemoryLlmCompletion = (
	prompt: string,
	opts?: YeMuMemoryLlmCompleteOptions,
) => string | null | Promise<string | null>;

/**
 * What an embedding provider's `embed` returns: the embedding matrix streamed as async batches,
 * matching fastembed's `embed()` (`AsyncGenerator<number[][]>`). Each yielded batch is a list of
 * rows; each row is one number per dimension. Yield the whole matrix as a single batch when not
 * streaming: `async *embed(texts) { yield texts.map(embedOne); }`.
 */
export type EmbeddingOutput = AsyncIterable<number[][]>;

export interface YeMuMemoryEmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export interface YeMuMemoryEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: YeMuMemoryEmbeddingProvider | ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>);
	/** Override `YEMU_MEMORY_EMBEDDING_MAX_INPUT_CHARS`. `0` disables the cap. See `config.embeddingMaxInputChars`. */
	maxInputChars?: number;
}

export interface YeMuMemoryLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: YeMuMemoryLlmCompletion;
	/** Override the fact-extraction prompt template ({text}/{lang}). Used to feed small local models a friendlier format. */
	extractionPrompt?: string;
	/** Override the consolidation/sleep prompt template ({memories}/{source}/{memory_count}). */
	consolidationPrompt?: string;
}

export interface YeMuMemoryRuntimeOptions {
	embeddings?: false | YeMuMemoryEmbeddingRuntimeOptions;
	llm?: false | YeMuMemoryLlmRuntimeOptions | Model<Api> | YeMuMemoryLlmCompletion;
	/** Verbose diagnostics: escalates best-effort failure logs from debug to warn. */
	debug?: boolean;
}

export interface ResolvedYeMuMemoryEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: YeMuMemoryEmbeddingProvider;
	maxInputChars?: number;
}

export interface ResolvedYeMuMemoryLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: YeMuMemoryLlmCompletion;
	extractionPrompt?: string;
	consolidationPrompt?: string;
}

export interface ResolvedYeMuMemoryRuntimeOptions {
	embeddings?: ResolvedYeMuMemoryEmbeddingRuntimeOptions;
	llm?: ResolvedYeMuMemoryLlmRuntimeOptions;
	debug?: boolean;
}

const runtimeOptionsStorage = new AsyncLocalStorage<ResolvedYeMuMemoryRuntimeOptions>();

export function withYeMuMemoryRuntimeOptions<T>(options: ResolvedYeMuMemoryRuntimeOptions | undefined, fn: () => T): T {
	if (options === undefined) {
		return fn();
	}
	return runtimeOptionsStorage.run(options, fn);
}

export function getYeMuMemoryRuntimeOptions(): ResolvedYeMuMemoryRuntimeOptions | undefined {
	return runtimeOptionsStorage.getStore();
}

/** Whether the active runtime scope requested verbose diagnostics (`yemu-memory.debug`). */
export function yemuMemoryDebugEnabled(): boolean {
	return runtimeOptionsStorage.getStore()?.debug === true;
}

export function resolveEmbeddingProvider(
	provider:
		| YeMuMemoryEmbeddingProvider
		| ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>)
		| undefined,
): YeMuMemoryEmbeddingProvider | undefined {
	if (provider === undefined) {
		return undefined;
	}
	if (typeof provider === "function") {
		return { embed: provider };
	}
	return provider;
}

export function isYemuAiModel(value: unknown): value is Model<Api> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const maybe = value as Partial<Model<Api>>;
	return (
		typeof maybe.id === "string" &&
		typeof maybe.provider === "string" &&
		typeof maybe.baseUrl === "string" &&
		typeof maybe.api === "string"
	);
}
