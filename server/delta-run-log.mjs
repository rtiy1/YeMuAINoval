/**
 * Bounded, lossless per-delta run log for writing-task streaming.
 *
 * dsh (`deepseek-harness` packages/core/session/src/chunk-rows.ts) packs runs of
 * consecutive same-block deltas into one durable row while keeping every token
 * boundary (`texts: string[]` is never joined) so expansion is exact. This
 * module applies the same packing discipline to YeMu's aggregate-oriented
 * writing task: a short-lived `task.deltaRuns` field that exists only while a
 * turn streams, is capped on write, and is deleted at finalization — the
 * canonical durable state remains `partialOutput` / `reasoningSummary` and the
 * segment-level `task.events`.
 *
 * **Privacy scope: this log is text-only by construction.** Chain-of-thought /
 * reasoning deltas can carry prompts, private material, or content the user
 * never consented to persist, and resume never needs them (the recovery prompt
 * tells the model not to re-think). `record('reasoning', …)` is therefore a
 * structural no-op; reasoning stays transient (streamed to the UI / in-memory
 * telemetry counters) and is never written to `db.json` by this module.
 *
 * Transport coalescing in `./task-stream.mjs` is orthogonal: it collapses frames
 * for the wire; this log records the same accepted text deltas per token for
 * durable resume/replay. Enable with `YEMU_DELTA_RUN_LOG=1`.
 *
 * @module server/delta-run-log
 */

/** Default cap on total logged streamed characters (oldest runs are dropped first). */
export const DELTA_RUN_MAX_CHARS = 512_000

/** Default cap on the number of distinct `(kind, segmentKey)` runs retained. */
export const DELTA_RUN_MAX_RUNS = 4_096

/** Default continuation transcript budget applied on worker resume (chars). */
export const RESUME_TAIL_CHARS = 12_000

/** Whether the delta run log is enabled for this process. */
export function isDeltaRunLogEnabled() {
  return process.env.YEMU_DELTA_RUN_LOG === '1'
}

/**
 * A single packed run: every streamed text delta of one `(kind, segmentKey)` is
 * kept as its own `texts` entry — values are never joined on write, so
 * expansion reproduces the exact original delta sequence. `kind` is always
 * `'text'` for the durable log; reasoning is excluded for privacy (§ record).
 *
 * @typedef {{
 *   kind: 'text',
 *   segmentKey: string,
 *   seq0: number,
 *   time0: number,
 *   texts: string[],
 * }} DeltaRun
 */

/**
 * Create an in-memory run logger. Runs are keyed by `(kind, segmentKey)` and
 * stay open for the whole turn (a burst spanning a checkpoint remains one run);
 * `snapshot()` returns them in first-append order. When total chars or run
 * count exceed the caps the oldest runs are dropped — they are already folded
 * into the aggregate `partialOutput`/`reasoningSummary`, so the log remains a
 * best-effort tail, never a second source of truth.
 */
export function createDeltaRunLog({
  maxChars = DELTA_RUN_MAX_CHARS,
  maxRuns = DELTA_RUN_MAX_RUNS,
} = {}) {
  const open = new Map()
  const order = []
  let totalChars = 0
  let seq = 0

  function dropOldest() {
    while (order.length > 0 && (totalChars > maxChars || order.length > maxRuns)) {
      const key = order.shift()
      const run = open.get(key)
      if (!run) continue
      open.delete(key)
      const runChars = run.texts.reduce((sum, text) => sum + text.length, 0)
      totalChars = Math.max(0, totalChars - runChars)
    }
  }

  return {
    /**
     * Append one streamed delta to its `(kind, segmentKey)` run.
     *
     * Only `kind === 'text'` is persisted; `'reasoning'` records are a
     * structural no-op so chain-of-thought can never reach `db.json` through
     * this log even if a caller forgets the privacy rule.
     * @param {'text'|'reasoning'} kind - the segment channel (`reasoning` is dropped).
     * @param {string} segmentKey - the output/reasoning segment identity (messageId).
     * @param {string} delta - the accepted delta (post-slice).
     * @param {number} [time] - epoch ms of the first delta of this run.
     */
    record(kind, segmentKey, delta, time = Date.now()) {
      if (kind !== 'text') return
      if (!delta || typeof delta !== 'string' || delta.length === 0) return
      const key = `${kind}:${segmentKey}`
      let run = open.get(key)
      if (!run) {
        run = { kind, segmentKey, seq0: seq, time0: time, texts: [] }
        open.set(key, run)
        order.push(key)
        seq += 1
      }
      run.texts.push(delta)
      totalChars += delta.length
      dropOldest()
    },
    /** Deep-clone the current runs (safe to JSON-serialize into `task.deltaRuns`). */
    snapshot() {
      return order.map((key) => {
        const run = open.get(key)
        return {
          kind: run.kind,
          segmentKey: run.segmentKey,
          seq0: run.seq0,
          time0: run.time0,
          texts: [...run.texts],
        }
      })
    },
    /** Total chars currently retained (before cap drops). */
    chars() {
      return totalChars
    },
  }
}

/**
 * Choose the assistant partial text to replay on worker resume. Prefers the
 * exact delta-run tail when the flag produced one, then falls back to the
 * aggregate `partialOutput` tail (the previous behavior).
 * @param {object} task - the writing task (may carry an optional `deltaRuns`).
 * @param {number} [budget] - max chars to keep from the tail.
 * @returns {string} the text to splice into the recovery conversation.
 */
export function resumeAssistantTail(task, budget = RESUME_TAIL_CHARS) {
  const deltaRuns = Array.isArray(task?.deltaRuns) ? task.deltaRuns : null
  if (deltaRuns && deltaRuns.length > 0) {
    const text = deltaRuns
      .map((run) => (Array.isArray(run?.texts) ? run.texts.join('') : ''))
      .join('')
    if (text.trim()) return text.slice(-budget)
  }
  const partialOutput = typeof task?.partialOutput === 'string' ? task.partialOutput : ''
  return partialOutput.trim() ? partialOutput.slice(-budget) : ''
}
