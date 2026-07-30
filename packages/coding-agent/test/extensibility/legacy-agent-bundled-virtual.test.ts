import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	__getLegacyAgentBundledModulesGlobal,
	__synthesizeLegacyAgentBundledSourceWithModules,
	resolveBundledVirtualSpecifier,
} from "@yemu/agent-runtime/extensibility/plugins/legacy-agent-compat";
import { TempDir } from "@yemu/utils";
import type { BunPlugin } from "bun";

// Regression for issue #3423: Bun 1.3.14 made `--compile` extras unreachable
// via every filesystem-style API. The compat layer now routes canonical
// `@yemu-*` imports through virtual modules backed by live host module
// references. The synthesizer must preserve every named/default export.
describe("legacy-agent bundled virtual module synthesizer (issue #3423)", () => {
	const modules = {
		"@yemu/agent-runtime": {
			VERSION: "16.1.17",
			defineTool: () => undefined,
			Type: { Object: () => undefined },
		},
		"@yemu/utils": {
			isCompiledBinary: () => false,
			default: () => "default-export",
			VERSION: "16.1.17",
		},
		typebox: {
			Type: { Object: () => undefined },
		},
	};
	const globalKey = __getLegacyAgentBundledModulesGlobal();

	it("emits one ES named export per enumerable namespace key", () => {
		const src = __synthesizeLegacyAgentBundledSourceWithModules("@yemu/agent-runtime", modules);
		expect(src).toContain(`const __yemu_bundled = globalThis[${JSON.stringify(globalKey)}]["@yemu/agent-runtime"];`);
		expect(src).toContain('export const VERSION = __yemu_bundled["VERSION"];');
		expect(src).toContain('export const defineTool = __yemu_bundled["defineTool"];');
		expect(src).toContain('export const Type = __yemu_bundled["Type"];');
		// Every named export emerges from a live module lookup — never the FS.
		expect(src).not.toMatch(/\$bunfs|file:\/\//);
	});

	it("forwards `default` through `export default` so default imports survive", () => {
		const src = __synthesizeLegacyAgentBundledSourceWithModules("@yemu/utils", modules);
		expect(src).toContain("export default __yemu_bundled.default;");
		// Default and named exports coexist on the same module.
		expect(src).toContain('export const VERSION = __yemu_bundled["VERSION"];');
		expect(src).toContain('export const isCompiledBinary = __yemu_bundled["isCompiledBinary"];');
	});

	it("omits `default` line when the registered namespace has no default export", () => {
		const src = __synthesizeLegacyAgentBundledSourceWithModules("@yemu/agent-runtime", modules);
		expect(src).not.toContain("export default");
	});

	it("throws when asked to synthesize a key the bundled modules do not cover", () => {
		expect(() => __synthesizeLegacyAgentBundledSourceWithModules("@yemu-not-bundled", modules)).toThrow(
			/no bundled module registered for @yemu\/yemu-not-bundled/,
		);
	});

	it("addresses the same globalThis key the install function would stash to", () => {
		// The emitted source MUST read from the exact key the install function
		// writes to — a rename of either side breaks every legacy extension
		// load with a `Cannot read properties of undefined` at first import.
		const src = __synthesizeLegacyAgentBundledSourceWithModules("typebox", modules);
		expect(src.startsWith(`const __yemu_bundled = globalThis[${JSON.stringify(globalKey)}]["typebox"];`)).toBe(true);
	});

	it("end-to-end: synthesized source resolves named bindings against a runtime globalThis entry", () => {
		// Evaluate the synthesized source in isolation. Bun's loader normally
		// turns it into an ES module; here we use `new Function` to exercise
		// the inner globalThis lookup + property-getter pattern in isolation —
		// it would `throw` if the emitted code addressed the wrong stash key
		// or skipped an enumerable export.
		Reflect.set(globalThis, globalKey, modules);
		try {
			const src = __synthesizeLegacyAgentBundledSourceWithModules("@yemu/agent-runtime", modules);
			// Strip the ES export prefix and run the body as a plain script so
			// we can read `__yemu_bundled` from the returned closure.
			const body = src
				.split("\n")
				.filter(line => line.startsWith("const __yemu_bundled"))
				.join("\n");
			const fn = new Function(`${body}; return __yemu_bundled;`);
			const live: unknown = fn();
			if (typeof live !== "object" || live === null) {
				throw new Error("synthetic module did not resolve an object namespace");
			}
			expect("VERSION" in live ? live.VERSION : undefined).toBe("16.1.17");
			expect(typeof ("defineTool" in live ? live.defineTool : undefined)).toBe("function");
			expect(typeof ("Type" in live ? live.Type : undefined)).toBe("object");
		} finally {
			Reflect.deleteProperty(globalThis, globalKey);
		}
	});

	it("routes Bun plugin resolution through the bundled namespace so onLoad can serve extension imports", async () => {
		using tempDir = TempDir.createSync("@yemu-legacy-agent-bundled-virtual-");
		const entryPath = tempDir.join("extension-entry.ts");
		const bundlePath = tempDir.join("extension-entry.bundle.mjs");

		await Bun.write(
			entryPath,
			[
				'import { legacyAnswer } from "yemu-legacy-agent-bundled:@yemu/utils";',
				"process.stdout.write(legacyAnswer);",
				"",
			].join("\n"),
		);

		expect(resolveBundledVirtualSpecifier("@yemu/utils")).toEqual({
			namespace: "yemu-legacy-agent-bundled",
			path: "@yemu/utils",
		});
		expect(resolveBundledVirtualSpecifier("yemu-legacy-agent-bundled:@yemu/utils")).toEqual({
			namespace: "yemu-legacy-agent-bundled",
			path: "@yemu/utils",
		});

		const onLoadPaths: string[] = [];
		const plugin: BunPlugin = {
			name: "yemu-legacy-agent-bundled-virtual-regression",
			setup(build) {
				build.onResolve({ filter: /^yemu-legacy-agent-bundled:.+$/, namespace: "file" }, args =>
					resolveBundledVirtualSpecifier(args.path),
				);
				build.onResolve({ filter: /.*/, namespace: "yemu-legacy-agent-bundled" }, args =>
					resolveBundledVirtualSpecifier(args.path),
				);
				build.onLoad({ filter: /.*/, namespace: "yemu-legacy-agent-bundled" }, args => {
					onLoadPaths.push(args.path);
					return {
						contents: `export const legacyAnswer = ${JSON.stringify(`served:${args.path}`)};`,
						loader: "js",
					};
				});
			},
		};

		const buildResult = await Bun.build({
			entrypoints: [entryPath],
			external: ["bun"],
			format: "esm",
			plugins: [plugin],
			target: "bun",
		});
		const buildLogs = buildResult.logs.map(log => log.message).join("\n");
		expect(buildResult.success, buildLogs).toBe(true);
		await Bun.write(bundlePath, await buildResult.outputs[0]!.text());
		expect(onLoadPaths).toEqual(["@yemu/utils"]);

		const proc = Bun.spawn([process.execPath, `./${path.basename(bundlePath)}`], {
			cwd: path.dirname(bundlePath),
			stderr: "pipe",
			stdout: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, stderr).toBe(0);
		expect(stderr).toBe("");
		expect(stdout).toBe("served:@yemu/utils");
	});
});
