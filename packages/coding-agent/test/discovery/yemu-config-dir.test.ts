import { afterEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { LoadContext } from "@yemu/agent-runtime/capability/types";
import { getConfigDirs } from "@yemu/agent-runtime/config";
import { getUserPath } from "@yemu/agent-runtime/discovery/helpers";
import { getAgentDir } from "@yemu/utils";

describe("YEMU_CONFIG_DIR", () => {
	const original = process.env.YEMU_CONFIG_DIR;
	afterEach(() => {
		if (original === undefined) {
			delete process.env.YEMU_CONFIG_DIR;
		} else {
			process.env.YEMU_CONFIG_DIR = original;
		}
	});

	test("getUserPath resolves the native user scope via getAgentDir (profile-aware)", () => {
		const ctx: LoadContext = {
			cwd: "/work/project",
			home: "/home/tester",
			repoRoot: null,
		};
		// Native user config follows the active profile through getAgentDir(), not
		// ctx.home, so it stays in sync with builtin.ts and getMCPConfigPath("user").
		// The old behavior joined ctx.home + ".yemu/agent" and leaked the default
		// profile's config into every profile.
		expect(getUserPath(ctx, "native", "commands")).toBe(path.join(getAgentDir(), "commands"));
		expect(getUserPath(ctx, "native", "commands")).not.toContain(ctx.home);
	});

	test("getConfigDirs respects YEMU_CONFIG_DIR for user base", () => {
		process.env.YEMU_CONFIG_DIR = ".config/yemu";
		const result = getConfigDirs("commands", { project: false });
		const expected = path.resolve(path.join(os.homedir(), ".config/yemu", "agent", "commands"));
		expect(result[0]).toEqual({ path: expected, source: ".yemu", level: "user" });
	});
});
