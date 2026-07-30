/**
 * Hello Tool - Minimal custom tool example
 *
 * Demonstrates using ExtensionAPI's logger, injected `yemu.zod`, and yemu module access.
 */
import type { ExtensionAPI } from "@yemu/agent-runtime";

export default function (yemu: ExtensionAPI) {
	const { z } = yemu.zod;

	yemu.registerTool({
		name: "hello",
		label: "Hello",
		description: "A simple greeting tool",
		parameters: z.object({
			name: z.string().describe("Name to greet"),
		}),

		async execute(_toolCallId, params, _onUpdate, _ctx, _signal) {
			const { name } = params;

			// Use logger for debugging
			yemu.logger.debug("Hello tool executed", { name });

			return {
				content: [{ type: "text", text: `Hello, ${name}!` }],
				details: { greeted: name },
			};
		},
	});
}
