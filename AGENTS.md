# YeMu Agent repository guide

## Project layout

- The repository root is the Web product: `src` is the React app, while `server` and `skills` provide the product backend and Story Skills.
- The story assistant is driven by the Claude Code CLI in headless mode: `server/assistant.mjs` spawns the `claude` binary and relays structured JSON events over a WebSocket to `src/assistant-panel.jsx`.
- `server/workspace.mjs` provides the per-user file workspace (chapters as Markdown on disk, `CLAUDE.md` context, per-user `CLAUDE_CONFIG_DIR`), and `server/skill-installer.mjs` installs Story Skills into each workspace.

## Development rules

- Use Bun 1.3.14 or newer for JavaScript and TypeScript tasks.
- Keep the default root commands focused on the YeMu product.
- Do not reintroduce the removed Python AI gateway or its legacy Docker stack. Docker deployment must run the current Bun server and embedded runtime directly.
- Do not expose unrestricted filesystem or shell tools through the story-agent boundary.
- Keep model credentials server-side and preserve the existing shared-key opt-in.
- Keep the Claude CLI binary dependency (`@anthropic-ai/claude-agent-sdk` for the platform binary) and the headless `-p --output-format stream-json` protocol; do not reintroduce PTY/terminal embedding.
- Use static imports. Avoid `any`, dynamic imports, and inferred `ReturnType` aliases.
- Preserve third-party license and copyright notices in `LICENSE` and `NOTICE.md`.

## Verification

Run from the repository root:

```bash
bun run check
bun run test
bun run build
```
