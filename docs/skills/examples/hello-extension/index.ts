// @ts-nocheck — example file; install @yemu/agent-runtime before running
import type { ExtensionAPI } from "@yemu/agent-runtime";

export default function helloExtension(yemu: ExtensionAPI) {
  // Show a greeting whenever a session starts.
  yemu.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Hello from hello-extension!", "info");
  });

  // Register a /hello slash command that sends a greeting into the conversation.
  yemu.registerCommand("hello", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "there";
      yemu.sendMessage(
        {
          customType: "hello-extension",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify("Message sent!", "info");
    },
  });
}
