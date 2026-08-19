# RFC: Lossless streaming delta run log for writing tasks

- Status: Accepted — implemented (this session)
- Scope: `server/writing-task-executor.mjs`, `server/task-stream.mjs`, `server/store.mjs`, `server/index.mjs` (SSE replay)
- Related work: this session already landed transport coalescing (12 ms tick + merged deltas in `task-stream.mjs`) and client-side RAF batching in `src/App.jsx`. This RFC is the **second, storage-side** half: whether and how to persist per-delta streaming output losslessly, modeled on DeepSeek Harness (`dsh`) `packages/core/session/src/chunk-rows.ts`.
- **Design decision added during implementation:** reasoning/CoT is **never persisted anywhere** (not just the delta log). The old `task.reasoningSummary` / reasoning `task.events` / `reasoningHistory` fields are no longer written, and `server/purge-reasoning.mjs` strips leftovers at boot. See §5.1 and §10.

## 1. Motivation

The perceived slowness of “thinking” streaming has two independent halves:

- **A. Transport / render latency** (why text appears late). Addressed by:
  - `server/task-stream.mjs` — buffer model deltas, merge consecutive same-segment deltas, flush on a 12 ms tick (or immediately on lifecycle events), so N token-sized SSE frames become ~1 per tick.
  - `src/App.jsx` `monitorAssistantTurn` — coalesce delta frames with `requestAnimationFrame` into one `setState` per frame.
- **B. Storage / replay fidelity** (what is durable when a worker dies or SSE reconnects). Today YeMu is aggregate-only: it persists `task.partialOutput` and `task.reasoningSummary` (capped strings) plus segment-level `task.events`. There is **no per-delta durable log**, so token boundaries are lost the moment a delta is folded into an aggregate string.

`dsh` solves B by keeping a durable session event log and packing each run of same-block deltas into one storage row (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`) that expands back to the exact original events. This RFC asks whether YeMu should adopt that, and how to do it cheaply inside YeMu’s aggregate-oriented model.

## 2. Reference: how dsh does it

Upstream repo: `github.com/deepseek-ai/deepseek-harness` (MIT).

- `packages/llm/llm-deepseek/src/translate.ts` — each SSE chunk becomes a `StreamChunk` (`text-delta` / `reasoning-delta` / `tool-call-delta`), token-sized, streamed live; `block-end`/`usage`/`finish` are deferred to the `[DONE]` sentinel.
- `packages/core/session/src/chunk-rows.ts` — packs **consecutive same-block delta runs** into one durable row:
  - `TextRunData { texts: string[] }` — token boundaries are data (each member kept, never joined), so expansion is exact/lossless.
  - `MIN_RUN = 3` — below that a row envelope rivals the events it replaces.
  - Unknown shapes are stored verbatim; encode/decode are whitelist-strict and fail loud on malformed packed rows.
- `packages/client/runtime/src/client/sessions/partial.ts` — client folds deltas into blocks with **block-level immutability** and skips notification for invisible chunks (`usage`/`finish`).
- `packages/llm/llm-deepseek/src/adapter.ts` — idle watchdog converts a stalled stream to `TIMEOUT`; missing `[DONE]` converts to `STREAM_CLOSED`.

Key insight for us: dsh does **not** merge deltas in transit; it preserves token granularity end-to-end and only compresses at the durable log. YeMu’s architecture is the opposite (aggregate-oriented), so we should not copy dsh wholesale — we copy only the *packing discipline* and apply it where YeMu actually persists.

## 3. Current state in YeMu

- `server/writing-task-executor.mjs`:
  - `flushOutputSegment` (≈L485) / `flushReasoningSummary` (≈L504) compute `acceptedDelta` per model delta, append to `partialOutput`/`reasoningSummary`, publish a coalesced stream event, and call `scheduleCheckpoint()`.
  - `flushCheckpoint` (≈L377) snapshots aggregates + segment `task.events` into `task` via `updateDb`, debounced 500 ms.
  - `resumeTaskFromCheckpoint` (≈L23) rebuilds history from `partialOutput.slice(-12_000)` + a recovery prompt — a coarse tail, so an interrupted write cannot be continued at its exact token boundary.
- `server/store.mjs` `updateDb` writes the **whole DB object** as indented JSON to a temp file + rename. Every extra persisted field on `task` therefore costs full-file write time and disk while present — a hard constraint on log size.
- `server/index.mjs` SSE stream (≈L2860) replays missed output by slicing `partialOutput` from `lastOutputLength` — aggregate-granular, already tolerant to drops.

## 4. Goals / non-goals

Goals:

- Add a **bounded, lossless** per-delta capability for the two real consumers we have: (1) worker-interrupt resume at exact token boundaries, (2) faithful SSE re-stream after reconnect.
- Keep the packing reuse-ready: pure encode/decode functions, whitelist-strict, unknown shapes stored verbatim (dsh discipline).
- Never regress the already-merged transport path.

Non-goals (for now, explicitly):

- A full per-delta session event log like dsh (YeMu has no fixture/trajectory replay consumer that needs one; whole-file `db.json` writes amplify it).
- Speeding up model reasoning tokens (provider-side; out of scope).
- Persisting per-delta data for the whole session lifetime (we roll up + prune).

## 5. Design

### 5.1 Data model: packed runs on the writing task

Add a single optional field, present only while a turn is streaming (`status === 'running'`), pruned on completion:

```ts
// task.deltaRuns?: packed delta run list (write-once during checkpoint)
interface DeltaRunBase {
  kind: 'text'                        // the log is TEXT-ONLY (privacy, see below)
  segmentKey: string                  // output segment identity (messageId)
  seq0: number                        // first delta ordinal in the run
  time0: number                       // epoch ms of first delta
  texts: string[]                     // each model delta kept SEPARATE — token boundaries are data
}
```

Rules (mirroring `chunk-rows`):

- **Privacy scope — no chain-of-thought is persisted.** Reasoning/CoT deltas can carry prompts, private material, or content the user never consented to store, and resume never needs them (the recovery prompt tells the model not to re-think). Reasoning is streamed live to the UI and counted in in-memory telemetry only; it is never written into `deltaRuns` or `db.json`. The module enforces this structurally (`record('reasoning', …)` is a no-op).
- A run contains **consecutive deltas of the same `(kind, segmentKey)`**; a segment switch starts a new run.
- `texts` is never joined; expansion yields the exact original delta sequence. This is the losslessness guarantee.
- Runs are only appended while streaming; on turn completion the field is either deleted or reduced to a small rolling tail (see §5.4), because the canonical durable state remains `partialOutput`/segment `task.events`.

### 5.2 Recording path

Hook **one place** — the executor, where `acceptedDelta` is already computed — not the stream subscriber, to avoid double accounting:

- `flushOutputSegment` appends `{ kind: 'text', segmentKey, delta }` to an in-memory per-run buffer (one open run per `(kind, segmentKey)`). `flushReasoningSummary` does **not** append — reasoning is never persisted (see §5.1).
- On run boundary (segment change) close the open run; on `flushCheckpoint` serialize the runs into `task.deltaRuns` alongside `partialOutput` (same 500 ms debounce, same single `updateDb`).

The transport merge in `task-stream.mjs` is orthogonal: it collapses frames for the wire; the run log records the same accepted deltas per token for durability. Neither depends on the other.

### 5.3 Consumption

1. **Worker-interrupt resume** (`resumeTaskFromCheckpoint`): when `task.deltaRuns` is present and non-empty, reconstruct the exact tail at its token boundary instead of `partialOutput.slice(-12_000)`. The recovery message can then say “continuing from token k of segment m” instead of “start from the tail of the last chunk”.
2. **SSE reconnect replay** (`server/index.mjs`): keep the existing aggregate-slice path as the fallback; when a `deltaRuns` tail is available, replay exact deltas for the requested window. This is optional (P2) — the current aggregate slice is already correct, just coarser.

### 5.4 Bounds and cleanup

Because `updateDb` rewrites the whole DB file:

- Cap total run characters (e.g. `DELTA_RUN_MAX_CHARS = 512_000`) and run count (e.g. `DELTA_RUN_MAX_RUNS = 4_096`); drop oldest runs beyond the cap (cheap: they are already folded into aggregates).
- On `completed`/`failed`/`cancelled`/`requeued` finalization, either delete `deltaRuns` or keep only the last N text runs for telemetry (opt-in via env).
- Encode `texts` per run as a JSON array of strings; object size for a 512 KiB cap stays well inside whole-file write budgets under the 500 ms debounce.

### 5.5 Encode/decode contract

- Pure functions `packDeltaRuns(runs) → DeltaRunLog` / `unpackDeltaRuns(log) → runs`.
- Whitelist-strict like dsh: a run with unexpected shape/keys is stored verbatim as opaque JSON and returned as-is on read; decoding never silently drops a run. Tests pin this.
- Guards: unsafe-integer `time0`/`seq0`, non-string `texts`, wrong `kind` → fail loud on decode (same posture as `chunk-rows`).

## 6. Rollout (staged)

- **P0 — telemetry only (no persistence)**: compute first-token time and inter-delta gaps in the runtime for observability. Zero storage risk; delivers most of the “is the thinking actually slow?” answer.
- **P1 — bounded resume log (recommended first landed feature)**: §5.1–§5.4 behind `YEMU_DELTA_RUN_LOG=1`, default off. If worker-interrupt resume precision isn’t a real pain, P0 may be all we ship.
- **P2 — exact SSE replay from the log**: optional, only if reconnect fidelity becomes a complaint.
- Never: a full-lifetime per-delta log in `db.json` without a dedicated log store.

## 7. Testing

- Encode/decode unit tests: round-trip, run-boundary splits, unknown-shape verbatim, malformed-run loud failure, empty-first-run (no fake reasoning block), >cap pruning.
- Executor integration test: stream synthetic deltas → assert `deltaRuns` written on checkpoint, rolled up and cleared on `completed`.
- Resume test: interrupt mid-run → assert continuation is exact to the token boundary (vs. the old coarse slice) with `partialOutput`/`reasoningSummary` consistent.
- SSE replay test: kill/re-subscribe mid-stream → replayed deltas reproduce the same aggregate without duplication (idempotent under `lastOutputLength`).
- Regression: `bun run test:unit` (all current 129 pass) plus `vite build`.

## 8. Alternatives considered

- **Full dsh-style event log** — rejected for now: no YeMu consumer needs token-boundary replay of completed turns; whole-file DB writes make unbounded logs expensive.
- **Status quo (aggregate only)** — fine for correctness; loses resume precision and any token-timing telemetry. Acceptable fallback if P1 shows no user pain.
- **Persist to a sidecar log file (not `db.json`)** — best long-term option if telemetry/resume ever grows; keep as “future work” since it adds a second durability path.

## 9. Open questions

1. Do we keep a rolling tail after completion (for traffic-light telemetry) or delete `deltaRuns` always?
2. Cap: character-based vs run-count-based; is 512 KiB the right default for `db.json` whole-file writes at scale?
3. Multi-segment interleave: confirm `(kind, segmentKey)` is a sufficient run key for the segmented output streams (messageId changes mid-turn happen only across tool boundaries — verify with `executionGeneration`).
4. Should the exact-tail resume message change user-facing copy in `resumeTaskFromCheckpoint`?
5. **Pre-existing reasoning persistence — RESOLVED (see §10).**

## 10. Decision log (implemented this session)

- **No-CoT-to-storage is now a product-wide rule, not just for the delta log.** Reasoning streams to the UI live (in-memory) and is then discarded:
  - `server/writing-task-executor.mjs` no longer writes `task.reasoningSummary`, reasoning-segment `task.events`, or `reasoningHistory`; the in-memory `reasoningSummary` local and `mergeReasoningSummaries` helper are removed.
  - `server/agent-thread.mjs` `archiveTaskReasoning()` becomes inert (its summary source is never set) but is kept for backward compatibility.
  - `server/index.mjs` new-task literals and turn resets no longer create the reasoning fields.
  - `server/purge-reasoning.mjs` removes all leftover reasoning data (`reasoningSummary`, `reasoningHistory`, reasoning timestamps, reasoning `events`, plus defensive thread fields) at boot, and logs `[purge-reasoning]` when it changed something.
  - Trade-off accepted: reloading a thread no longer re-renders past “thinking” blocks (they are live-only). Live streaming and DeepSeek CoT passback are unaffected (passback reads in-memory message content, not `db.json`).
