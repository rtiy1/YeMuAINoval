import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@yemu/agent-runtime/cli/args";
import { ModelRegistry } from "@yemu/agent-runtime/config/model-registry";
import { Settings } from "@yemu/agent-runtime/config/settings";
import { buildSessionOptions } from "@yemu/agent-runtime/main";
import { AuthStorage } from "@yemu/agent-runtime/session/auth-storage";
import { SessionManager } from "@yemu/agent-runtime/session/session-manager";
import { getBundledModel } from "@yemu/model-catalog/models";
import { removeSyncWithRetries, Snowflake } from "@yemu/utils";

// Regression for #6064: prewalk is an optional, off-by-default optimization.
// A missing key (or unresolvable target) for the prewalk hand-off model must
// leave prewalk unarmed with a warning, never abort startup and lock the user
// out of the app.
describe("prewalk startup degradation", () => {
	let tempDir: string;
	const authStoragesToClose: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `yemu-prewalk-repro-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of authStoragesToClose) authStorage.close();
		authStoragesToClose.length = 0;
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	async function newRegistry(name: string): Promise<{ authStorage: AuthStorage; modelRegistry: ModelRegistry }> {
		const authStorage = await AuthStorage.create(path.join(tempDir, `${name}.db`));
		authStoragesToClose.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, `${name}.yml`));
		return { authStorage, modelRegistry };
	}

	test("leaves prewalk unarmed instead of crashing when the target has no configured auth", async () => {
		const settings = Settings.isolated();
		settings.set("prewalk.enabled", true);
		settings.setModelRole("smol", "cerebras/zai-glm-4.7");
		const { modelRegistry } = await newRegistry("no-auth");
		// Force the no-auth condition: hasAuth() also consults $HOME/.env via
		// getEnvApiKey (packages/utils/src/env.ts), so a CEREBRAS_API_KEY in the
		// runner's home .env would otherwise legitimately arm prewalk and make
		// this test environment-dependent.
		vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(false);

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk).toBeUndefined();
	});

	test("arms prewalk when the target resolves and has configured auth", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const settings = Settings.isolated();
		settings.set("prewalk.enabled", true);
		settings.setModelRole("smol", `${model.provider}/${model.id}`);
		const { authStorage, modelRegistry } = await newRegistry("with-auth");
		authStorage.setRuntimeApiKey(model.provider, "test-key");

		const options = await buildSessionOptions(parseArgs([]), [], SessionManager.inMemory(), modelRegistry, settings);

		expect(options.prewalk?.target.provider).toBe(model.provider);
		expect(options.prewalk?.target.id).toBe(model.id);
	});
});
