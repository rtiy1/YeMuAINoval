import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getConfigDirName,
	getDocumentConversionCacheDir,
	getProfileRootDir,
	setAgentDir,
} from "@yemu/utils/dirs";
import { Snowflake } from "@yemu/utils/snowflake";

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}

describe("document conversion cache directory", () => {
	let tempRoot = "";
	let originalYemuCodingAgentDir: string | undefined;
	let originalYemuProfile: string | undefined;
	let originalYemuLegacyProfile: string | undefined;
	let originalXdgCacheHome: string | undefined;

	beforeEach(async () => {
		originalYemuCodingAgentDir = process.env.YEMU_CODING_AGENT_DIR;
		originalYemuProfile = process.env.YEMU_PROFILE;
		originalYemuLegacyProfile = process.env.YEMU_LEGACY_PROFILE;
		originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		tempRoot = path.join(os.tmpdir(), "yemu-utils-document-cache", Snowflake.next());
		await fs.mkdir(tempRoot, { recursive: true });
	});

	afterEach(async () => {
		restoreEnv("YEMU_CODING_AGENT_DIR", originalYemuCodingAgentDir);
		restoreEnv("YEMU_PROFILE", originalYemuProfile);
		restoreEnv("YEMU_LEGACY_PROFILE", originalYemuLegacyProfile);
		restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
		__resetDirsFromEnvForTests();
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("uses XDG_CACHE_HOME for the default agent dir when $XDG_CACHE_HOME/yemu exists", async () => {
		if (process.platform === "win32") return;

		process.env.XDG_CACHE_HOME = path.join(tempRoot, "cache");
		await fs.mkdir(path.join(process.env.XDG_CACHE_HOME, "yemu"), { recursive: true });

		const defaultAgentDir = path.join(os.homedir(), getConfigDirName(), "agent");
		setAgentDir(defaultAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(
			path.join(process.env.XDG_CACHE_HOME, "yemu", "cache", "document-conversions"),
		);
	});

	it("stays under a custom YEMU_CODING_AGENT_DIR", () => {
		const customAgentDir = path.join(tempRoot, "custom-agent");

		setAgentDir(customAgentDir);

		expect(getDocumentConversionCacheDir()).toBe(path.join(customAgentDir, "cache", "document-conversions"));
	});
});

describe("test directory state cleanup", () => {
	it("restores the active profile from the current env after setAgentDir mutations", () => {
		const originalYemuCodingAgentDir = process.env.YEMU_CODING_AGENT_DIR;
		const originalYemuProfile = process.env.YEMU_PROFILE;
		const originalYemuLegacyProfile = process.env.YEMU_LEGACY_PROFILE;
		const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
		try {
			process.env.YEMU_PROFILE = "cache-profile";
			delete process.env.YEMU_LEGACY_PROFILE;
			delete process.env.YEMU_CODING_AGENT_DIR;
			delete process.env.XDG_CACHE_HOME;
			__resetDirsFromEnvForTests();

			setAgentDir(path.join(os.tmpdir(), "yemu-utils-document-cache", Snowflake.next(), "agent"));
			expect(getActiveProfile()).toBeUndefined();

			delete process.env.YEMU_PROFILE;
			process.env.YEMU_LEGACY_PROFILE = "cache-profile";
			delete process.env.YEMU_CODING_AGENT_DIR;
			__resetDirsFromEnvForTests();

			expect(getActiveProfile()).toBe("cache-profile");
			expect(getDocumentConversionCacheDir()).toBe(
				path.join(getProfileRootDir("cache-profile"), "agent", "cache", "document-conversions"),
			);
		} finally {
			restoreEnv("YEMU_CODING_AGENT_DIR", originalYemuCodingAgentDir);
			restoreEnv("YEMU_PROFILE", originalYemuProfile);
			restoreEnv("YEMU_LEGACY_PROFILE", originalYemuLegacyProfile);
			restoreEnv("XDG_CACHE_HOME", originalXdgCacheHome);
			__resetDirsFromEnvForTests();
		}
	});
});
