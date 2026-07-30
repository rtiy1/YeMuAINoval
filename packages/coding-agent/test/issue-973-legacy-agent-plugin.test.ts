import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@yemu/agent-runtime/extensibility/extensions/loader";
import { TempDir } from "@yemu/utils";

const currentYemuCodingAgentPath = Bun.resolveSync("@yemu/agent-runtime", import.meta.dir);
const currentYemuExtensionsPath = Bun.resolveSync("@yemu/agent-runtime/extensibility/extensions", import.meta.dir);

describe("issue #973: legacy YeMu plugin imports", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@issue-973-");
		const pluginDir = path.join(projectDir.path(), "legacy-agent-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "legacy-agent-plugin",
				version: "1.0.0",
				yemu: {
					extensions: ["./dist/extension.ts"],
				},
			}),
		);
		fs.writeFileSync(
			extensionPath,
			[
				'import { isToolCallEventType as legacyRoot } from "@yemu/agent-runtime";',
				'import { isToolCallEventType as legacyExtensions } from "@yemu/agent-runtime/extensibility/extensions";',
				`import { isToolCallEventType as modernRoot } from ${JSON.stringify(currentYemuCodingAgentPath)};`,
				`import { isToolCallEventType as modernExtensions } from ${JSON.stringify(currentYemuExtensionsPath)};`,
				"",
				'if (legacyRoot !== modernRoot) throw new Error("legacy root import did not remap");',
				'if (legacyExtensions !== modernExtensions) throw new Error("legacy extension import did not remap");',
				"",
				"export default function(yemu) {",
				'\tpi.registerCommand("legacy-agent-ext", { handler: async () => {} });',
				"}",
			].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("loads plugin extensions that still import legacy @mariozechner YeMu packages", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		const extension = result.extensions.find(ext => ext.path === extensionPath);

		expect(result.errors).toEqual([]);
		expect(extension).toBeDefined();
		expect(extension?.commands.has("legacy-agent-ext")).toBe(true);
	});
});
