// @ts-nocheck — example file; install @yemu/agent-runtime before running
import type { ExtensionAPI } from "@yemu/agent-runtime";

export default function myPlugin(yemu: ExtensionAPI) {
  yemu.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("my-plugin loaded from example marketplace!", "info");
  });
}
