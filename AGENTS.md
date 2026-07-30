# YeMu Agent repository guide

## Project layout

- `packages/yemu-novel-agent` is the product: React, Tauri, Bun API, task queue, story data, and Story Skills.
- `packages/agent`, `packages/ai`, `packages/catalog`, `packages/coding-agent`, and related workspaces are the embedded agent runtime.
- `packages/yemu-novel-agent/src/agent-runtime.ts` is the boundary between the product and the embedded runtime.
- `packages/yemu-novel-agent/src/prompts` contains model-facing prompts. Keep prompts in static Markdown files.

## Development rules

- Use Bun 1.3.14 or newer for JavaScript and TypeScript tasks.
- Keep the default root commands focused on the YeMu product.
- Do not reintroduce the removed Python AI gateway, Docker deployment stack, or release publishing automation.
- Do not expose unrestricted filesystem or shell tools through the story-agent boundary.
- Keep model credentials server-side and preserve the existing shared-key opt-in.
- Use static imports. Avoid `any`, dynamic imports, and inferred `ReturnType` aliases.
- Preserve third-party license and copyright notices in `LICENSE` and `NOTICE.md`.

## Verification

Run from the repository root:

```bash
bun run check
bun run test
bun run build
```

Use `bun run core:check` only when changing the embedded runtime itself.
