# YeMuMemory memory backend

YeMu Agent can use `@yemu/memory` as a local long-term memory backend.

Set:

```yaml
memory:
  backend: yemu-memory
```

Example:

```yaml
memory:
  backend: yemu-memory
yemu-memory:
  scoping: per-project-tagged
```

With this backend enabled, the coding agent:

1. Opens one or more local YeMuMemory SQLite databases according to the configured bank scoping.
2. Recalls relevant memories into a `<memories>` block for the first model turn of a session and refreshes the base prompt if recall happens from the `agent_start` listener.
3. Retains completed conversation turns into the retain bank after agent turns, no more often than `yemu-memory.retainEveryNTurns`.
4. Adds recalled memory as extra compaction context when compaction asks the memory backend for `preCompactionContext`.
5. Uses the normal `/memory view`, `/memory stats`, `/memory diagnose`, `/memory clear`, and `/memory enqueue` commands through the shared memory backend interface.

Recalled memory is background context, not instructions. Current user messages and tool output take precedence when they conflict.

## Settings

| Setting                         | Default                | Description                                                                                                                                                             |
| ------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`                | `off`                  | Set to `yemu-memory` to enable this backend.                                                                                                                              |
| `yemu-memory.dbPath`              | agent memories dir     | Optional SQLite database path.                                                                                                                                          |
| `yemu-memory.bank`                | unset                  | Optional shared bank base name passed to `YeMuMemory`; the coding-agent wrapper scopes from this base according to `yemu-memory.scoping`. Unset → shared bank `default`; per-project modes derive a project bank from the working-directory basename plus a stable hash of its absolute path. |
| `yemu-memory.scoping`             | `per-project`          | Memory visibility mode: `global` = one shared bank, `per-project` = isolated project memory, `per-project-tagged` = project-local writes plus global recall visibility. |
| `yemu-memory.autoRecall`          | `true`                 | Recall memory on the first turn of a session.                                                                                                                           |
| `yemu-memory.autoRetain`          | `true`                 | Retain completed turns automatically.                                                                                                                                   |
| `yemu-memory.polyphonicRecall`    | `false`                | Enable 4-voice polyphonic recall (vector, graph, fact, temporal) with reciprocal rank fusion; `YEMU_MEMORY_POLYPHONIC_RECALL` overrides when set.                            |
| `yemu-memory.enhancedRecall`      | `false`                | Enable the tiered query result cache for repeated/similar recall queries; `YEMU_MEMORY_ENHANCED_RECALL` overrides when set.                                                  |
| `yemu-memory.retainEveryNTurns`   | `4`                    | Minimum user turns between automatic retain writes.                                                                                                                     |
| `yemu-memory.recallLimit`         | `8`                    | Maximum recalled memories in the prompt block.                                                                                                                          |
| `yemu-memory.recallContextTurns`  | `3`                    | Prior user-bounded turns included in recall queries.                                                                                                                    |
| `yemu-memory.recallMaxQueryChars` | `4000`                 | Maximum composed recall query length.                                                                                                                                   |
| `yemu-memory.injectionTokenLimit` | `5000`                 | Approximate token budget for memory prompt injection.                                                                                                                   |
| `yemu-memory.debug`               | `false`                | Enable debug logging for backend failures.                                                                                                                              |
| `yemu-memory.noEmbeddings`        | `false`                | Pass `noEmbeddings` to `YeMuMemory` and force FTS-only recall.                                                                                                           |
| `yemu-memory.embeddingVariant`    | `en`                   | Local embedding model variant: `en` = `BAAI/bge-base-en-v1.5` (768d), `multilingual` = `intfloat/multilingual-e5-large` (1024d). `yemu-memory.embeddingModel`/`YEMU_MEMORY_EMBEDDING_MODEL` override it; changing it rebuilds stored embeddings on the next writable start. |
| `yemu-memory.embeddingModel`      | variant default        | Explicit embedding model id; overrides `yemu-memory.embeddingVariant`. Precedence: this setting > `YEMU_MEMORY_EMBEDDING_MODEL` env > variant default.                          |
| `yemu-memory.embeddingApiUrl`     | env/default            | OpenAI-compatible embedding endpoint passed to `YeMuMemory`.                                                                                                             |
| `yemu-memory.embeddingApiKey`     | env/default            | Embedding API key passed to `YeMuMemory`.                                                                                                                                |
| `yemu-memory.llmMode`             | `smol`                 | `smol` uses the configured model-runtime smol model, `remote` uses the settings below, and `none` disables LLM calls.                                                           |
| `yemu-memory.llmBaseUrl`          | env/default            | OpenAI-compatible LLM endpoint for `llmMode: remote`.                                                                                                                   |
| `yemu-memory.llmApiKey`           | env/default            | LLM API key for `llmMode: remote`.                                                                                                                                      |
| `yemu-memory.llmModel`            | env/default            | LLM model id for `llmMode: remote`.                                                                                                                                     |

## Scoping

The coding-agent wrapper applies scoping on top of the underlying `YeMuMemory` package:

- `global` uses one shared bank for recall and writes.
- `per-project` writes to and recalls from a bank derived from the current working directory alone — its basename plus a stable hash of its absolute path, independent of the surrounding git layout.
- `per-project-tagged` writes to the project-local bank and recalls from both the project-local bank and the shared global bank, with duplicate recall results merged.

The combined project-plus-global behavior lives in the wrapper. The `@yemu/memory` package itself still exposes banks and constructor options directly, including `bank` for selecting a bank name. Project-local banks other than the shared bank are stored as sibling bank databases managed by YeMuMemory's `BankManager`.

## LLM and embeddings

The backend passes these settings to the `YeMuMemory` constructor; if a setting is omitted, YeMuMemory falls back to its `YEMU_MEMORY_*` environment defaults. The backend does not download or run a local GGUF LLM. LLM-dependent paths use a configured model-runtime model, an opt-in local on-device memory model (`providers.memoryModel`, ONNX — overrides `smol`/`remote` when set to a local model), a dynamic completion function, a remote OpenAI-compatible endpoint, or deterministic no-LLM fallbacks.

FTS-only:

```yaml
memory:
  backend: yemu-memory
yemu-memory:
  noEmbeddings: true
```

Equivalent constructor shape:

```ts
new YeMuMemory({ noEmbeddings: true });
```

Remote embeddings:

```yaml
yemu-memory:
  embeddingModel: text-embedding-3-small
  embeddingApiUrl: https://api.openai.com/v1
  embeddingApiKey: ${OPENAI_API_KEY}
```

Equivalent constructor shape:

```ts
new YeMuMemory({
  embeddingModel: "text-embedding-3-small",
  embeddingApiUrl: "https://api.openai.com/v1",
  embeddingApiKey,
});
```

Remote LLM:

```yaml
yemu-memory:
  llmMode: remote
  llmBaseUrl: https://api.openai.com/v1
  llmApiKey: ${OPENAI_API_KEY}
  llmModel: gpt-4.1-mini
```

Equivalent constructor shapes:

```ts
new YeMuMemory({ llm: { baseUrl, apiKey, model } });
new YeMuMemory({ llmBaseUrl: baseUrl, llmApiKey: apiKey, llmModel: model });
```

Dynamic function LLM for rotating OAuth tokens:

```ts
new YeMuMemory({
  llm: async (prompt, opts) => {
    const token = await getFreshOauthToken();
    return await completeWithYemuAi(prompt, {
      token,
      maxTokens: opts?.maxTokens,
      temperature: opts?.temperature,
    });
  },
});
```

model-runtime smol model LLM:

```yaml
yemu-memory:
  llmMode: smol
```

The coding agent resolves its configured smol role and passes a dynamic completion function so every YeMuMemory LLM call can fetch the current provider credentials at call time:

```ts
new YeMuMemory({
  llm: async (prompt, opts) => completeSmolWithCurrentAuth(prompt, opts),
});
```

## Operational notes

- The default shared database lives under the agent memories directory in `yemu-memory/yemu-memory.db`; project-scoped banks use sibling database paths under that YeMuMemory directory.
- `/memory clear` removes every scoped YeMuMemory SQLite database and sidecar WAL/SHM files for the active configuration.
- `/memory enqueue` forces retention of the current session, flushes pending fact extractions, and runs YeMuMemory sleep/consolidation.
- `/memory stats` and `/memory diagnose` render backend-specific bank statistics/diagnostics when the YeMuMemory backend is active.
- Subagents do not own separate YeMuMemory retain loops; they alias the parent state when a parent YeMuMemory state exists, and otherwise remain inert.
