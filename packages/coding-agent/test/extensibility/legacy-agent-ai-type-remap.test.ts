import { afterAll, afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import {
	__resetLegacyAgentResolutionCache,
	installLegacyAgentSpecifierShim,
	loadLegacyAgentModule,
} from "@yemu/agent-runtime/extensibility/plugins/legacy-agent-compat";
import { Type as TypeBoxShimType } from "@yemu/agent-runtime/extensibility/typebox";
import {
	calculateCost,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	modelsAreEqual,
} from "@yemu/model-catalog/models";
import { removeWithRetries } from "@yemu/utils";

// model-runtime 15.1.0 removed the runtime `Type` export from `@yemu/model-runtime`'s
// package root. Legacy extensions (and their aliased-scope variants such as
// `@yemu/model-runtime`) still author parameter schemas as
// `import { Type } from "@yemu/model-runtime"` and then `Type.Object(...)`.
// `legacy-agent-compat.ts` patches that gap by redirecting bare model-runtime root
// imports through `legacy-model-runtime-shim.ts`, which re-exports the canonical
// model-runtime surface plus the Zod-backed `Type` runtime from the same TypeBox shim
// `@sinclair/typebox` is served from.
installLegacyAgentSpecifierShim();

const tempRoots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const dir of tempRoots) {
		await removeWithRetries(dir);
	}
});

async function writeFixtureExtension(source: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-model-runtime-type-remap-"));
	tempRoots.push(dir);
	const entry = path.join(dir, "index.ts");
	await fs.writeFile(entry, source, "utf8");
	return entry;
}

describe("legacy-agent @(scope)/model-runtime root `Type` remap (issue #1437)", () => {
	it('redirects `import { Type } from "@yemu/model-runtime"` to the TypeBox shim', async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type } from "@yemu/model-runtime";',
				"export const probe = Type;",
				"export const schema = Type.Object({ name: Type.String() }, { additionalProperties: false });",
			].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as {
			probe: typeof TypeBoxShimType;
			schema: { safeParse: (input: unknown) => { success: boolean } };
		};

		expect(loaded.probe).toBe(TypeBoxShimType);
		expect(loaded.schema.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.schema.safeParse({}).success).toBe(false);
		expect(loaded.schema.safeParse({ name: "ok", extra: 1 }).success).toBe(false);
	});

	it("redirects the legacy model-runtime compat entrypoint through the root compatibility shim", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { StringEnum, complete, type Model } from "@yemu/model-runtime/compat";',
				'export const schema = StringEnum(["red", "green"] as const);',
				"export const completeType = typeof complete;",
				"export type LegacyModel = Model;",
			].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as {
			schema: { safeParse: (input: unknown) => { success: boolean } };
			completeType: string;
		};
		expect(loaded.schema.safeParse("red").success).toBe(true);
		expect(loaded.schema.safeParse("blue").success).toBe(false);
		expect(loaded.completeType).toBe("function");
	});

	it('redirects `import { Type } from "@yemu/model-runtime"` for plugins published against the canonical scope', async () => {
		const entry = await writeFixtureExtension(
			['import { Type } from "@yemu/model-runtime";', "export const probe = Type;"].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as { probe: typeof TypeBoxShimType };
		expect(loaded.probe).toBe(TypeBoxShimType);
	});

	it("preserves canonical model-runtime exports alongside the shimmed Type (z is still re-exported)", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { Type, z } from "@yemu/model-runtime";',
				"export const obj = Type.Object({ name: Type.String() });",
				"export const zodObj = z.object({ name: z.string() });",
			].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as {
			obj: { safeParse: (input: unknown) => { success: boolean } };
			zodObj: { safeParse: (input: unknown) => { success: boolean } };
		};

		expect(loaded.obj.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.zodObj.safeParse({ name: "ok" }).success).toBe(true);
		expect(loaded.zodObj.safeParse({}).success).toBe(false);
	});

	it("does not redirect subpath imports such as @yemu/model-runtime/utils/schema", async () => {
		const entry = await writeFixtureExtension(
			[
				// `zodToWireSchema` is only exported from the subpath, not the root,
				// so a successful import proves the subpath still resolves directly
				// against the bundled model-runtime package rather than the shim.
				'import { zodToWireSchema } from "@yemu/model-runtime/utils/schema";',
				"export const fn = zodToWireSchema;",
			].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as { fn: unknown };
		expect(typeof loaded.fn).toBe("function");
	});

	it("exports getModel as getBundledModel", async () => {
		const loaded = (await loadLegacyAgentModule(
			await writeFixtureExtension(
				'import { getModel } from "@yemu/model-runtime"; export const testGetModel = getModel;',
			),
		)) as { testGetModel: unknown };
		expect(loaded.testGetModel).toBe(getBundledModel);
	});

	it("exports getModels as getBundledModels", async () => {
		const loaded = (await loadLegacyAgentModule(
			await writeFixtureExtension(
				'import { getModels } from "@yemu/model-runtime"; export const testGetModels = getModels;',
			),
		)) as { testGetModels: unknown };
		expect(loaded.testGetModels).toBe(getBundledModels);
	});

	it("re-exports calculateCost from @yemu/model-catalog/models (issue #4584)", async () => {
		// `calculateCost` was moved from the `@yemu/model-runtime` barrel to
		// `@yemu/model-catalog/models` in the catalog split. Legacy extensions
		// still import it from the model-runtime root, so the shim must bridge it back
		// to the catalog implementation. The historical regression was a plain
		// `SyntaxError: Export named 'calculateCost' not found in module
		// '.../legacy-model-runtime-shim.ts'` at extension-validation time.
		const loaded = (await loadLegacyAgentModule(
			await writeFixtureExtension(
				'import { calculateCost } from "@yemu/model-runtime"; export const probe = calculateCost;',
			),
		)) as { probe: unknown };
		expect(loaded.probe).toBe(calculateCost);
	});

	it("re-exports modelsAreEqual and getBundledProviders from @yemu/model-catalog/models", async () => {
		const loaded = (await loadLegacyAgentModule(
			await writeFixtureExtension(
				[
					'import { modelsAreEqual, getBundledProviders } from "@yemu/model-runtime";',
					"export const eq = modelsAreEqual;",
					"export const providers = getBundledProviders;",
				].join("\n"),
			),
		)) as { eq: unknown; providers: unknown };
		expect(loaded.eq).toBe(modelsAreEqual);
		expect(loaded.providers).toBe(getBundledProviders);
	});

	it("re-exports getBundledModel and getBundledModels from @yemu/model-catalog/models", async () => {
		const loaded = (await loadLegacyAgentModule(
			await writeFixtureExtension(
				[
					'import { getBundledModel, getBundledModels } from "@yemu/model-runtime";',
					"export const model = getBundledModel;",
					"export const models = getBundledModels;",
				].join("\n"),
			),
		)) as { model: unknown; models: unknown };
		expect(loaded.model).toBe(getBundledModel);
		expect(loaded.models).toBe(getBundledModels);
	});

	it("exports clampThinkingLevel with the historical off fallback", async () => {
		const loaded = await loadLegacyAgentModule(
			await writeFixtureExtension(
				[
					'import { clampThinkingLevel } from "@yemu/model-runtime";',
					"export const supported = clampThinkingLevel({ reasoning: true, thinking: { efforts: ['low', 'high'] } }, 'high');",
					"export const disabled = clampThinkingLevel({ reasoning: false }, 'high');",
				].join("\n"),
			),
		);

		expect(loaded).toMatchObject({ supported: "high", disabled: "off" });
	});

	it("exports StringEnum as a schema builder with options support", async () => {
		const loaded = (await loadLegacyAgentModule(
			await writeFixtureExtension(
				[
					'import { StringEnum } from "@yemu/model-runtime";',
					'export const schema = StringEnum(["red", "green"] as const, { description: "primary colors" });',
				].join("\n"),
			),
		)) as { schema: { safeParse: (input: unknown) => { success: boolean }; toJSON?: () => any } };

		expect(loaded.schema.safeParse("red").success).toBe(true);
		expect(loaded.schema.safeParse("blue").success).toBe(false);
		expect(loaded.schema.toJSON?.()?.description).toBe("primary colors");
	});

	it("exports isRetryableAssistantError for legacy retry classification (issue #6847)", async () => {
		// `@yemu/model-runtime@0.82.x` exports isRetryableAssistantError from its
		// package root (utils/retry.js). Plugins such as
		// `@router-for-me/yemu-cliproxyapi-provider` (>=1.4.9) import it, so a missing
		// shim export surfaced as a plain
		// `Export named 'isRetryableAssistantError' not found` at validation time.
		const loaded = (await loadLegacyAgentModule(
			await writeFixtureExtension(
				[
					'import { isRetryableAssistantError } from "@yemu/model-runtime";',
					'const err = errorMessage => ({ role: "assistant", stopReason: "error", errorMessage });',
					'export const transient = isRetryableAssistantError(err("upstream connect error"));',
					'export const quota = isRetryableAssistantError(err("insufficient_quota"));',
					'export const ok = isRetryableAssistantError({ role: "assistant", stopReason: "stop" });',
				].join("\n"),
			),
		)) as { transient: boolean; quota: boolean; ok: boolean };

		expect(loaded.transient).toBe(true);
		expect(loaded.quota).toBe(false);
		expect(loaded.ok).toBe(false);
	});
});

describe("legacy yemu package root remaps (issue #1474)", () => {
	it("loads @yemu/agent-runtime root imports when host package resolution is unavailable", async () => {
		const realResolveSync = Bun.resolveSync.bind(Bun);
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@yemu/agent-runtime" && from.endsWith(path.join("src", "extensibility", "plugins"))) {
				throw new Error("compiled binary host package resolution unavailable");
			}
			return realResolveSync(specifier, from);
		});
		const entry = await writeFixtureExtension(
			['import { VERSION } from "@yemu/agent-runtime";', "export const loadedVersion = VERSION;"].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as { loadedVersion: string };
		expect(loaded.loadedVersion).toMatch(/^\d+\.\d+\.\d+/);
	});

	it("loads yemu-vimmode's minified legacy imports", async () => {
		const entry = await writeFixtureExtension(
			[
				'import{CustomEditor,copyToClipboard}from"@yemu/agent-runtime";',
				'import{CURSOR_MARKER,decodeKittyPrintable,matchesKey,parseKey,truncateToWidth,visibleWidth}from"@yemu/tui";',
				"export const apiTypes=[typeof CustomEditor,typeof copyToClipboard,typeof CURSOR_MARKER,typeof decodeKittyPrintable,typeof matchesKey,typeof parseKey,typeof truncateToWidth,typeof visibleWidth];",
				'export const printable=decodeKittyPrintable("\\x1b[97u");',
			].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as { apiTypes: string[]; printable: string };
		expect(loaded.apiTypes).toEqual([
			"function",
			"function",
			"string",
			"function",
			"function",
			"function",
			"function",
			"function",
		]);
		expect(loaded.printable).toBe("a");
	});

	it("loads yemu-sprite's legacy terminal helpers", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { deleteAllKittyImages, deleteKittyImage, getCapabilities } from "@yemu/tui";',
				"export const deleteOne = deleteKittyImage(42);",
				"export const deleteAll = deleteAllKittyImages();",
				"export const capabilities = getCapabilities();",
			].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as {
			deleteOne: string;
			deleteAll: string;
			capabilities: { images: "kitty" | "iterm2" | null; trueColor: boolean; hyperlinks: boolean };
		};
		// Bare sequences, exactly like upstream YeMu: legacy callers (yemu-sprite)
		// apply their own tmux passthrough wrapping.
		expect(loaded.deleteOne).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		expect(loaded.deleteAll).toBe("\x1b_Ga=d,d=A,q=2\x1b\\");
		expect(["kitty", "iterm2", null]).toContain(loaded.capabilities.images);
		expect(typeof loaded.capabilities.trueColor).toBe("boolean");
		expect(typeof loaded.capabilities.hyperlinks).toBe("boolean");
	});

	it("preserves legacy defineTool root imports and usable coding tools", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-legacy-coding-tools-"));
		tempRoots.push(dir);
		await fs.writeFile(path.join(dir, "sample.txt"), "legacy read body", "utf8");
		const entry = path.join(dir, "index.ts");
		await fs.writeFile(
			entry,
			[
				'import { dirname } from "node:path";',
				'import { fileURLToPath } from "node:url";',
				'import { createCodingTools, defineTool, Type } from "@yemu/agent-runtime";',
				"const definition = {",
				'\tname: "legacy_define_tool",',
				'\tlabel: "Legacy Define Tool",',
				'\tdescription: "legacy helper probe",',
				"\tparameters: Type.Object({}),",
				'\texecute: async () => ({ content: [{ type: "text", text: "ok" }] }),',
				"};",
				"const cwd = dirname(fileURLToPath(import.meta.url));",
				"const codingTools = createCodingTools(cwd);",
				"const readTool = codingTools.find(tool => tool.name === 'read');",
				"export const tool = defineTool(definition);",
				"export const sameReference = tool === definition;",
				"export const codingToolNames = codingTools.map(tool => tool.name);",
				"export const readResult = await readTool?.execute('legacy-read', { path: 'sample.txt' });",
			].join("\n"),
			"utf8",
		);

		const loaded = (await loadLegacyAgentModule(entry)) as {
			tool: { name: string; parameters: { safeParse: (input: unknown) => { success: boolean } } };
			sameReference: boolean;
			codingToolNames: string[];
			readResult: { content: Array<{ type: string; text?: string }> };
		};

		expect(loaded.sameReference).toBe(true);
		expect(loaded.tool.name).toBe("legacy_define_tool");
		expect(loaded.codingToolNames).toEqual(["read", "bash", "edit", "write"]);
		expect(loaded.readResult.content[0]?.text).toContain("legacy read body");
	});

	it("preserves legacy frontmatter helper root imports", async () => {
		const entry = await writeFixtureExtension(
			[
				'import { parseFrontmatter, stripFrontmatter } from "@yemu/agent-runtime";',
				"const content = ['---', 'name: demo', '---', '# Body'].join('\\n');",
				"export const parsed = parseFrontmatter(content);",
				"export const stripped = stripFrontmatter(content);",
			].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as {
			parsed: { frontmatter: { name?: string }; body: string };
			stripped: string;
		};

		expect(loaded.parsed.frontmatter.name).toBe("demo");
		expect(loaded.parsed.body).toBe("# Body");
		expect(loaded.stripped).toBe("# Body");
	});

	it("falls back to legacy-scoped subpath peers for direct plugin imports", async () => {
		const realResolveSync = Bun.resolveSync.bind(Bun);
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@yemu/model-runtime/oauth") {
				throw new Error(`canonical peer unavailable from ${from}`);
			}
			return realResolveSync(specifier, from);
		});

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-legacy-direct-subpath-"));
		tempRoots.push(dir);
		const packageDir = path.join(dir, "node_modules", "@mariozechner", "model-runtime");
		await fs.mkdir(packageDir, { recursive: true });
		await fs.writeFile(
			path.join(packageDir, "package.json"),
			JSON.stringify({ type: "module", exports: { "./oauth": "./oauth.js" } }),
			"utf8",
		);
		await fs.writeFile(path.join(packageDir, "oauth.js"), 'export const marker = "legacy-oauth";', "utf8");
		const entry = path.join(dir, "index.ts");
		await fs.writeFile(
			entry,
			['import { marker } from "@yemu/model-runtime/oauth";', "export const loadedMarker = marker;"].join("\n"),
			"utf8",
		);

		const loaded = (await import(`${url.pathToFileURL(entry).href}?nonce=${Date.now()}`)) as {
			loadedMarker: string;
		};
		expect(loaded.loadedMarker).toBe("legacy-oauth");
	});

	it("routes @yemu/utils through canonical Bun.resolveSync in non-compiled mode", async () => {
		// Regression: when yemu runs from a node_modules install (not the monorepo
		// and not a compiled binary), the bundled packages live at
		// `node_modules/@yemu-*`, not next to the source tree. Hardcoding
		// a sibling `packages/<pkg>/src/index.ts` path would miss them, so the
		// non-compiled branch must delegate to `Bun.resolveSync` against the
		// canonical specifier.
		// The resolver memoizes canonical lookups process-wide; clear it so this
		// assertion observes the Bun.resolveSync delegation rather than a warm
		// cache populated by an earlier test in the full suite.
		__resetLegacyAgentResolutionCache();
		const realResolveSync = Bun.resolveSync.bind(Bun);
		let canonicalLookupSeen = false;
		vi.spyOn(Bun, "resolveSync").mockImplementation((specifier: string, from: string) => {
			if (specifier === "@yemu/utils") {
				canonicalLookupSeen = true;
			}
			return realResolveSync(specifier, from);
		});
		const entry = await writeFixtureExtension(
			['import { isCompiledBinary } from "@yemu/utils";', "export const probe = isCompiledBinary;"].join("\n"),
		);

		const loaded = (await loadLegacyAgentModule(entry)) as { probe: () => boolean };
		expect(typeof loaded.probe).toBe("function");
		expect(canonicalLookupSeen).toBe(true);
	});
});
