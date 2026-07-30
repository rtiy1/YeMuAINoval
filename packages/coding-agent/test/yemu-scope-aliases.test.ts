/**
 * Regression: plugin extensions must resolve `yemu-*` imports across every scope
 * that has ever been used to publish or alias the internal packages —
 * `@mariozechner` (original), `@earendil-works` (fork), and `@yemu`
 * (canonical). The shim in `legacy-agent-compat.ts` remaps all three to the same
 * in-process bundled copy so that plugins observe a single module registry
 * regardless of which scope name their peerDependencies happened to declare.
 *
 * Reported failures the test covers:
 *   - `@juicesharp/rpiv-ask-user-question` ⇒ `@yemu/tui`
 *   - `@yemu/swarm-extension`         ⇒ `@yemu/utils`
 *   - `@plannotator/yemu-extension`         ⇒ `@yemu/agent-core`
 *   - `@runfusion/fusion`                 ⇒ `@yemu/agent-runtime/...`
 *
 * Plus the two upstream-only surfaces that turned up via real-plugin E2E:
 *   - `Key` runtime helper from `yemu-tui` (used by plannotator + rpiv-*).
 *   - `model-runtime/oauth` subpath (used by runfusion's bundled extension).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@yemu/agent-runtime/extensibility/extensions/loader";
import { TempDir } from "@yemu/utils";

const canonicalCodingAgent = Bun.resolveSync("@yemu/agent-runtime", import.meta.dir);
const canonicalCodingAgentExtensions = Bun.resolveSync("@yemu/agent-runtime/extensibility/extensions", import.meta.dir);
const canonicalUtils = Bun.resolveSync("@yemu/utils", import.meta.dir);
const canonicalTui = Bun.resolveSync("@yemu/tui", import.meta.dir);
// Subpath: upstream `model-runtime/oauth` re-exported `utils/oauth/index`; our model-runtime now
// exposes the same surface at the real `@yemu/model-runtime/oauth` export, so the
// legacy `@yemu/model-runtime/oauth` specifier canonicalizes straight to it.
const canonicalAiOauth = Bun.resolveSync("@yemu/model-runtime/oauth", import.meta.dir);

interface AliasCase {
	id: string;
	aliasSpecifier: string;
	canonicalPath: string;
	symbol: string;
}

const CASES: readonly AliasCase[] = [
	// @earendil-works fork — used by @juicesharp/rpiv-* plugins.
	{
		id: "earendil-tui",
		aliasSpecifier: "@yemu/tui",
		canonicalPath: canonicalTui,
		symbol: "visibleWidth",
	},
	// @yemu self-import — canonical scope must still flow through the shim
	// so a duplicate copy is never dragged in from a plugin's own node_modules.
	{ id: "yemu-utils", aliasSpecifier: "@yemu/utils", canonicalPath: canonicalUtils, symbol: "logger" },
	{
		id: "yemu-coding-agent",
		aliasSpecifier: "@yemu/agent-runtime",
		canonicalPath: canonicalCodingAgent,
		symbol: "isToolCallEventType",
	},
	// @mariozechner — defends the original remap (regression: issue #973).
	{
		id: "mariozechner-extensions",
		aliasSpecifier: "@yemu/agent-runtime/extensibility/extensions",
		canonicalPath: canonicalCodingAgentExtensions,
		symbol: "isToolCallEventType",
	},
	// Subpath: legacy `model-runtime/oauth` resolves to the real `@yemu/model-runtime/oauth`.
	{
		id: "mariozechner-ai-oauth",
		aliasSpecifier: "@yemu/model-runtime/oauth",
		canonicalPath: canonicalAiOauth,
		// `refreshOAuthToken` is exported by our `oauth/index` and by upstream's
		// `oauth.d.ts`; it makes a stable probe across both layouts.
		symbol: "refreshOAuthToken",
	},
	// `Key` runtime helper restored on yemu-tui (plannotator + rpiv-* import it).
	{
		id: "earendil-tui-key",
		aliasSpecifier: "@yemu/tui",
		canonicalPath: canonicalTui,
		symbol: "Key",
	},
];

describe("yemu-* scope aliases", () => {
	let projectDir: TempDir;
	let extensionPath: string;

	beforeEach(() => {
		projectDir = TempDir.createSync("@yemu-scope-aliases-");
		const pluginDir = path.join(projectDir.path(), "alias-probe-plugin");
		extensionPath = path.join(pluginDir, "dist", "extension.ts");
		fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name: "alias-probe-plugin",
				version: "1.0.0",
				yemu: { extensions: ["./dist/extension.ts"] },
			}),
		);

		// Each case imports the same symbol via the aliased scope and via the
		// resolved canonical absolute path. The default factory throws unless the
		// two are object-identical, proving they came from a single module
		// instance.
		const lines: string[] = [];
		const checks: string[] = [];
		for (const [idx, c] of CASES.entries()) {
			lines.push(`import { ${c.symbol} as alias${idx} } from "${c.aliasSpecifier}";`);
			lines.push(`import { ${c.symbol} as canonical${idx} } from ${JSON.stringify(c.canonicalPath)};`);
			checks.push(
				`if (alias${idx} !== canonical${idx}) throw new Error(${JSON.stringify(
					`${c.aliasSpecifier} did not remap to the bundled copy (case ${c.id})`,
				)});`,
			);
		}

		fs.writeFileSync(
			extensionPath,
			[...lines, "", ...checks, "", "export default function(yemu) {", "\t/* no-op */", "}"].join("\n"),
		);
	});

	afterEach(() => {
		projectDir.removeSync();
	});

	it("remaps every aliased yemu-* scope and known upstream subpath to the bundled in-process copy", async () => {
		const result = await loadExtensions([extensionPath], projectDir.path());
		expect(result.errors).toEqual([]);
		const extension = result.extensions.find(ext => ext.path === extensionPath);
		expect(extension).toBeDefined();
	});
});
