import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@yemu/agent-runtime/capability/context-file";
import { resetSettingsForTest, Settings } from "@yemu/agent-runtime/config/settings";
import { initializeWithSettings, loadCapability } from "@yemu/agent-runtime/discovery";
import { __resetDirsFromEnvForTests, removeWithRetries, setAgentDir } from "@yemu/utils";

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

describe("disabledExtensions runtime filtering", () => {
	let tempDir = "";
	let tempHomeDir = "";
	let originalHome: string | undefined;
	let originalAgentDirEnv: string | undefined;
	let originalYemuProfileEnv: string | undefined;
	let originalYemuLegacyProfileEnv: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		originalAgentDirEnv = process.env.YEMU_CODING_AGENT_DIR;
		originalYemuProfileEnv = process.env.YEMU_PROFILE;
		originalYemuLegacyProfileEnv = process.env.YEMU_LEGACY_PROFILE;
		originalHome = process.env.HOME;
		tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-disabled-ext-home-"));
		process.env.HOME = tempHomeDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHomeDir);
		setAgentDir(path.join(tempHomeDir, ".yemu", "agent"));
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-disabled-ext-"));
		await fs.mkdir(path.join(tempDir, ".yemu"), { recursive: true });
		await fs.writeFile(path.join(tempDir, ".yemu", "AGENTS.md"), "# project instructions\n");

		const settings = await Settings.init({
			inMemory: true,
			cwd: tempDir,
			overrides: {
				disabledExtensions: ["context-file:project:AGENTS.md"],
			},
		});
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		vi.restoreAllMocks();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("YEMU_PROFILE", originalYemuProfileEnv);
		restoreEnvValue("YEMU_LEGACY_PROFILE", originalYemuLegacyProfileEnv);
		restoreEnvValue("YEMU_CODING_AGENT_DIR", originalAgentDirEnv);
		__resetDirsFromEnvForTests();
		await removeWithRetries(tempHomeDir);
		await removeWithRetries(tempDir);
	});

	test("hides disabled context files from runtime loads by default", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd: tempDir });

		expect(result.items).toHaveLength(0);
	});

	test("can include disabled context files for dashboard-style loads", async () => {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: tempDir,
			includeDisabled: true,
		});

		expect(result.items).toHaveLength(1);
		expect(path.basename(result.items[0]!.path)).toBe("AGENTS.md");
	});
});
