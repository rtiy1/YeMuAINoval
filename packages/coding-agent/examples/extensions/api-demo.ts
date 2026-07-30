/**
 * API Demo Extension
 *
 * Demonstrates using ExtensionAPI's logger, injected `yemu.zod`, and yemu module access.
 * These features are now exposed directly on the ExtensionAPI, matching
 * the CustomToolAPI interface.
 */
import type { ExtensionAPI } from "@yemu/agent-runtime";

export default function (yemu: ExtensionAPI) {
	const { z } = yemu.zod;

	// Access the logger for debugging
	yemu.logger.debug("API demo extension loaded");

	yemu.registerTool({
		name: "api_demo",
		label: "API Demo",
		description: "Demonstrates ExtensionAPI capabilities: logger, zod, and yemu module access",
		parameters: z.object({
			message: z.string().describe("Test message"),
			logLevel: z.enum(["error", "warn", "debug"]).default("debug").describe("Log level to use"),
		}),

		async execute(_toolCallId, params, _onUpdate, ctx, _signal) {
			const { message, logLevel } = params;

			// Use logger at specified level
			yemu.logger[logLevel]("API demo tool executed", { message, logLevel });

			// Access yemu module utilities
			const { logger: yemuLogger } = yemu.runtime;
			yemuLogger.debug("Accessed yemu module from extension", { sessionFile: ctx.sessionManager.getSessionFile() });

			// Get session information
			const sessionInfo = `Session: ${ctx.sessionManager.getSessionFile()}`;
			const modelInfo = ctx.model ? `Model: ${ctx.model.id}` : "Model: none";

			return {
				content: [
					{
						type: "text",
						text: [
							`API Demo Tool executed successfully!`,
							``,
							`Message: ${message}`,
							`Log Level: ${logLevel}`,
							``,
							`Features demonstrated:`,
							`1. ✓ Logger access via yemu.logger`,
							`2. ✓ Zod access via yemu.zod`,
							`3. ✓ YeMu runtime access via yemu.runtime`,
							``,
							`Context:`,
							`- ${sessionInfo}`,
							`- ${modelInfo}`,
							`- CWD: ${ctx.cwd}`,
						].join("\n"),
					},
				],
				details: {
					message,
					logLevel,
					sessionFile: ctx.sessionManager.getSessionFile(),
					modelId: ctx.model?.id,
				},
			};
		},
	});

	// Demonstrate event handling with logger
	yemu.on("session_start", async () => {
		yemu.logger.debug("Session started", { extension: "api-demo" });
	});

	yemu.on("agent_start", async () => {
		yemu.logger.debug("Agent started", { extension: "api-demo" });
	});
}
