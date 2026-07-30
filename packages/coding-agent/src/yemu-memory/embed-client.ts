import { logger } from "@yemu/utils";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	type WorkerHandle,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import type {
	YeMuMemoryEmbedModelId,
	YeMuMemoryEmbedWorkerInbound,
	YeMuMemoryEmbedWorkerOutbound,
} from "./embed-protocol";

/**
 * Parent-side handle for the yemu-memory embeddings subprocess. The runtime
 * implementation is a Bun child process so `onnxruntime-node`'s NAPI
 * constructor + finalizer never run inside the main agent address space —
 * those destructors segfault Bun on Windows when yemu-memory's local embedding
 * provider loads fastembed in the main process (issue #3031; the yemu-memory
 * sibling of the tiny-model fix from #1606 / #1607).
 */
export type YeMuMemoryEmbedWorkerHandle = WorkerHandle<YeMuMemoryEmbedWorkerInbound, YeMuMemoryEmbedWorkerOutbound>;

type PendingRequest =
	| { kind: "init"; model: YeMuMemoryEmbedModelId; resolve: (ok: boolean) => void }
	| { kind: "embed"; model: YeMuMemoryEmbedModelId; resolve: (vectors: number[][] | Error) => void };

/**
 * Hidden subcommand on the main CLI that boots the yemu-memory embeddings worker
 * in the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const YEMU_MEMORY_EMBED_WORKER_ARG = "__yemu_worker_yemu-memory_embed";

/**
 * Spawn the yemu-memory embeddings worker as a subprocess. Exported for tests and
 * the smoke probe; production callers go through {@link spawnYeMuMemoryEmbedWorker}.
 * The child inherits the parent env verbatim — fastembed honours `HF_HUB_*`,
 * `HTTPS_PROXY`, etc., and our `loadFastembed()` reads the same `YEMU_*`
 * runtime-install knobs the parent uses.
 */
export function createYeMuMemoryEmbedSubprocess(): SpawnedSubprocess<YeMuMemoryEmbedWorkerOutbound> {
	return createWorkerSubprocess<YeMuMemoryEmbedWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(YEMU_MEMORY_EMBED_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "yemu-memory embed subprocess",
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<YeMuMemoryEmbedWorkerOutbound>): YeMuMemoryEmbedWorkerHandle {
	const { proc } = spawned;
	// Embed keeps its own guarded `proc.send` (neutralizes only the synchronous
	// throw, not the async EPIPE rejection) rather than the shared `safeSend`
	// the other workers use — behaviour preserved verbatim.
	return createWorkerHandle<YeMuMemoryEmbedWorkerInbound, YeMuMemoryEmbedWorkerOutbound>(spawned, message => {
		try {
			proc.send(message);
		} catch (error) {
			logger.debug("yemu-memory-embed: send to subprocess failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});
}

function spawnYeMuMemoryEmbedWorker(): YeMuMemoryEmbedWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createYeMuMemoryEmbedSubprocess()),
		createUnavailableWorker<YeMuMemoryEmbedWorkerInbound, YeMuMemoryEmbedWorkerOutbound>,
		"yemu-memory embed worker spawn failed; local embeddings disabled",
	);
}

/**
 * Per-model wrapper produced by {@link YeMuMemoryEmbedClient.initialize}.
 * `embed()` round-trips one batch of texts through the worker subprocess and
 * yields the resulting vectors in a single asynchronous batch — fastembed's
 * own iterator was emitting batches that we collect on the child side anyway,
 * and serializing per-batch over IPC would not improve throughput.
 */
export interface YeMuMemorySubprocessEmbeddingModel {
	embed(texts: string[], batchSize?: number): AsyncIterable<number[][]>;
}

export class YeMuMemoryEmbedClient {
	#worker: YeMuMemoryEmbedWorkerHandle | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#nextRequestId = 0;
	#spawnWorker: () => YeMuMemoryEmbedWorkerHandle;

	constructor(spawnWorker: () => YeMuMemoryEmbedWorkerHandle = spawnYeMuMemoryEmbedWorker) {
		this.#spawnWorker = spawnWorker;
	}

	/**
	 * Load the named fastembed model inside the subprocess. Resolves to a
	 * thin wrapper whose `embed()` round-trips through the same worker, or
	 * `null` when the worker cannot init the model (missing peer, native
	 * load failure, etc.). Multiple calls with the same model reuse the
	 * single in-flight worker; calling with a different model loads it on
	 * the child without restarting the process.
	 */
	async initialize(
		model: YeMuMemoryEmbedModelId,
		cacheDir: string | undefined,
	): Promise<YeMuMemorySubprocessEmbeddingModel | null> {
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#pending.set(id, { kind: "init", model, resolve });
			try {
				worker.send({ type: "init", id, model, cacheDir });
				const ok = await promise;
				if (!ok) return null;
			} finally {
				this.#pending.delete(id);
			}
		} catch (error) {
			logger.debug("yemu-memory-embed: init failed", {
				model,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		return { embed: (texts, batchSize) => this.#streamEmbed(model, cacheDir, texts, batchSize) };
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(new Error("yemu-memory embed worker terminated"));
		}
		this.#pending.clear();
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	async #embed(
		model: YeMuMemoryEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): Promise<number[][]> {
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve } = Promise.withResolvers<number[][] | Error>();
		this.#pending.set(id, { kind: "embed", model, resolve });
		try {
			// Carry the (model, cacheDir) the wrapper was bound to in every
			// embed message: dispose + respawn between two embeds on the same
			// `LocalEmbeddingModel` handle would otherwise hit a fresh
			// worker's "embed before init" guard. Worker `ensureLoaded` is
			// idempotent so steady-state embeds pay no extra cost.
			worker.send({ type: "embed", id, model, cacheDir, texts, batchSize });
			const result = await promise;
			if (result instanceof Error) throw result;
			return result;
		} finally {
			this.#pending.delete(id);
		}
	}

	async *#streamEmbed(
		model: YeMuMemoryEmbedModelId,
		cacheDir: string | undefined,
		texts: string[],
		batchSize: number | undefined,
	): AsyncIterable<number[][]> {
		const vectors = await this.#embed(model, cacheDir, texts, batchSize);
		// YeMuMemory's `collectMatrix` re-batches via async iteration anyway; yield
		// a single batch carrying the full result so the caller's drain loop
		// behaves identically to the in-process fastembed iterator (one yield
		// per `embed()` call) without paying extra IPC round-trips.
		yield vectors;
	}

	#ensureWorker(): YeMuMemoryEmbedWorkerHandle {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	#handleMessage(message: YeMuMemoryEmbedWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if (message.type === "ready") {
			if (pending.kind === "init") pending.resolve(true);
			return;
		}
		if (message.type === "vectors") {
			if (pending.kind === "embed") pending.resolve(message.vectors);
			return;
		}
		logger.debug("yemu-memory-embed: worker returned error", { error: message.error });
		if (pending.kind === "init") pending.resolve(false);
		else pending.resolve(new Error(message.error));
	}

	#handleWorkerError(error: Error): void {
		logger.warn("yemu-memory-embed: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			if (pending.kind === "init") pending.resolve(false);
			else pending.resolve(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const yemuMemoryEmbedClient = new YeMuMemoryEmbedClient();

export async function shutdownYeMuMemoryEmbedClient(): Promise<void> {
	await yemuMemoryEmbedClient.terminate();
}

export async function smokeTestYeMuMemoryEmbedWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createYeMuMemoryEmbedSubprocess()), "yemu-memory embed worker", timeoutMs);
}
