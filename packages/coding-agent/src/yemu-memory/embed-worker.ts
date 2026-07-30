/**
 * YeMuMemory local-embeddings worker. Loaded inside the dedicated subprocess
 * spawned by `embed-client.ts` (re-entered through the agent CLI's hidden
 * `__yemu_worker_yemu-memory_embed` selector). The whole point of this module is
 * that `loadFastembed()` — and therefore `onnxruntime-node`'s NAPI
 * constructor + finalizer — only ever runs in this child address space. The
 * parent `SIGKILL`s us on shutdown so the destructor that crashes Bun on
 * Windows shutdown (issue #3031, yemu-memory sibling of #1606/#1607) never runs
 * in either process.
 */

import { defaultLocalModelInitializer, type StandardEmbeddingModel } from "@yemu/memory/core";
import type { YeMuMemoryEmbedModelId, YeMuMemoryEmbedTransport, YeMuMemoryEmbedWorkerInbound } from "./embed-protocol";

interface LoadedModel {
	model: YeMuMemoryEmbedModelId;
	cacheDir: string | undefined;
	instance: {
		embed(texts: string[], batchSize?: number): AsyncIterable<number[][]> | Iterable<number[][]>;
	};
}

let loaded: Promise<LoadedModel> | null = null;
let loadedKey = "";

async function loadModel(model: YeMuMemoryEmbedModelId, cacheDir: string | undefined): Promise<LoadedModel> {
	// Route through yemu-memory's shared initializer so the worker inherits BOTH
	// cache heals (sidecar re-fetch AND corrupt-model quarantine/retry) —
	// fastembed/onnxruntime still load only in this child address space, the
	// initializer calls loadFastembed() itself.
	// Cast: `model` arrives as a string from the parent (resolved by
	// yemu-memory's `fastembedModelName`); the parent only ever passes pre-vetted
	// fast-* identifiers.
	const instance = await defaultLocalModelInitializer({
		model: model as StandardEmbeddingModel,
		cacheDir,
		showDownloadProgress: false,
	});
	return { model, cacheDir, instance };
}

function ensureLoaded(model: YeMuMemoryEmbedModelId, cacheDir: string | undefined): Promise<LoadedModel> {
	const key = `${model}\u0000${cacheDir ?? ""}`;
	if (loaded !== null && loadedKey === key) return loaded;
	const loading = loadModel(model, cacheDir).catch(error => {
		// Failed loads must not poison the cache — a retry with the same key
		// should re-attempt the load.
		if (loaded === loading) {
			loaded = null;
			loadedKey = "";
		}
		throw error;
	});
	loaded = loading;
	loadedKey = key;
	return loading;
}
async function handleEmbed(
	transport: YeMuMemoryEmbedTransport,
	message: Extract<YeMuMemoryEmbedWorkerInbound, { type: "embed" }>,
): Promise<void> {
	try {
		// Each `embed` carries the model + cacheDir the wrapper was bound to.
		// `ensureLoaded` is idempotent for the same key, so this is a no-op
		// once the model is in memory — and it transparently re-loads after
		// the parent SIGKILLed the previous subprocess but yemu-memory still
		// holds the cached `LocalEmbeddingModel` wrapper from before.
		const { instance } = await ensureLoaded(message.model, message.cacheDir);
		const vectors: number[][] = [];
		const batches = instance.embed([...message.texts], message.batchSize);
		for await (const batch of batches) {
			for (const row of batch) vectors.push(row);
		}
		transport.send({ type: "vectors", id: message.id, vectors });
	} catch (error) {
		transport.send({
			type: "error",
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function handleInit(
	transport: YeMuMemoryEmbedTransport,
	message: Extract<YeMuMemoryEmbedWorkerInbound, { type: "init" }>,
): Promise<void> {
	try {
		await ensureLoaded(message.model, message.cacheDir);
		transport.send({ type: "ready", id: message.id });
	} catch (error) {
		transport.send({
			type: "error",
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export function startYeMuMemoryEmbedWorker(transport: YeMuMemoryEmbedTransport): void {
	transport.onMessage(message => {
		switch (message.type) {
			case "ping":
				transport.send({ type: "pong", id: message.id });
				return;
			case "init":
				void handleInit(transport, message);
				return;
			case "embed":
				void handleEmbed(transport, message);
				return;
		}
	});
}
