import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { __computeBundledSelfPackageRoot } from "@yemu/agent-runtime/extensibility/plugins/legacy-agent-compat";

// Issue #3423 removed the runtime bunfs-path computation (`__computeBunfsPackageRoot`,
// `__joinBunfsPath`, `bunfsPath`): Bun 1.3.14 stopped exposing `--compile`
// extras through any filesystem API, so the compat layer now routes the
// bundled host packages and shims through the `yemu-legacy-agent-bundled:`
// virtual namespace (see `legacy-agent-bundled-virtual.test.ts`). The bunfs
// path computation is dead and its regression tests (issues #1514, #3329)
// retired alongside the code.
//
// The npm-prebuilt `dist/cli.js` self-package-root computation is still in
// use by `sourceShimPath` in installed-package mode, so its contract stays
// pinned below.
describe("legacy yemu compat bundled-self package root computation", () => {
	it("derives the npm prebuilt bundle package root from dist import.meta.dir", () => {
		const winMetaDir = "C:\\Users\\me\\.bun\\install\\global\\node_modules\\@yemu\\agent-runtime\\dist";
		expect(__computeBundledSelfPackageRoot(winMetaDir, path.win32)).toBe(
			"C:\\Users\\me\\.bun\\install\\global\\node_modules\\@yemu\\agent-runtime",
		);

		const posixMetaDir = "/home/me/.bun/install/global/node_modules/@yemu/agent-runtime/dist";
		expect(__computeBundledSelfPackageRoot(posixMetaDir, path.posix)).toBe(
			"/home/me/.bun/install/global/node_modules/@yemu/agent-runtime",
		);
	});

	it("derives the source package root when YEMU_BUNDLED is used outside dist", () => {
		const winMetaDir = "C:\\repo\\packages\\coding-agent\\src\\extensibility\\plugins";
		expect(__computeBundledSelfPackageRoot(winMetaDir, path.win32)).toBe("C:\\repo\\packages\\coding-agent");

		const posixMetaDir = "/repo/packages/coding-agent/src/extensibility/plugins";
		expect(__computeBundledSelfPackageRoot(posixMetaDir, path.posix)).toBe("/repo/packages/coding-agent");
	});
});
