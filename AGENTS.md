# YeMu Agent repository guide

## Project layout

- The repository root is the Web product: `src` is the React app, while `server` and `skills` provide the product backend and Story Skills.
- `packages/agent`, `packages/ai`, `packages/catalog`, `packages/coding-agent`, and related workspaces are the embedded agent runtime.
- `src/agent-runtime.ts` is the boundary between the product and the embedded runtime.
- `src/prompts` contains model-facing prompts. Keep prompts in static Markdown files.

## Development rules

- Use Bun 1.3.14 or newer for JavaScript and TypeScript tasks.
- Keep the default root commands focused on the YeMu product.
- Do not reintroduce the removed Python AI gateway or its legacy Docker stack. Docker deployment must run the current Bun server and embedded runtime directly.
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
