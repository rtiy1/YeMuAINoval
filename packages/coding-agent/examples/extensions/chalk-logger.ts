/**
 * Example extension that uses a 3rd party dependency (chalk).
 * Tests that jiti can resolve npm modules correctly.
 */
import type { ExtensionAPI } from "@yemu/agent-runtime";
import chalk from "chalk";

export default function (yemu: ExtensionAPI) {
	// Log with colors using chalk
	console.log(`${chalk.green("✓")} ${chalk.bold("chalk-logger extension loaded")}`);

	yemu.on("agent_start", async () => {
		console.log(`${chalk.blue("[chalk-logger]")} Agent starting`);
	});

	yemu.on("tool_call", async event => {
		console.log(`${chalk.yellow("[chalk-logger]")} Tool: ${chalk.cyan(event.toolName)}`);
		return undefined;
	});

	yemu.on("agent_end", async event => {
		const count = event.messages.length;
		console.log(`${chalk.green("[chalk-logger]")} Done with ${chalk.bold(String(count))} messages`);
	});
}
