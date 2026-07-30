import type { Settings } from "../config/settings";
import { localBackend } from "./local-backend";
import { offBackend } from "./off-backend";
import type { MemoryBackend } from "./types";

/**
 * Pick the active memory backend for a Settings instance.
 *
 * Selection rules (single source of truth — every memory consumer routes
 * through this):
 *   - `memory.backend === "hindsight"`  → Hindsight remote memory
 *   - `memory.backend === "yemu-memory"`  → local YeMuMemory SQLite memory
 *   - `memory.backend === "local"`      → local rollout summary pipeline
 *   - everything else                   → no-op
 *
 * `memories.enabled` remains accepted only as a legacy migration input. Once
 * a config is loaded, `memory.backend` is the sole runtime selector.
 */
export async function resolveMemoryBackend(settings: Settings): Promise<MemoryBackend> {
	const id = settings.get("memory.backend");
	if (id === "hindsight") return (await import("../hindsight/backend")).hindsightBackend;
	if (id === "yemu-memory") return (await import("../yemu-memory/backend")).yemuMemoryBackend;
	if (id === "local") return localBackend;
	return offBackend;
}
