import { spyOn } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@yemu/agent-runtime/config/model-registry";
import { AuthStorage } from "@yemu/agent-runtime/session/auth-storage";
import * as buildModule from "@yemu/model-catalog/build";
import { TempDir } from "@yemu/utils";

const tempDir = TempDir.createSync("@model-registry-lazy-probe-");
const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
const buildSpy = spyOn(buildModule, "buildModel");
try {
	new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	process.stdout.write(JSON.stringify({ buildCalls: buildSpy.mock.calls.length }));
} finally {
	buildSpy.mockRestore();
	authStorage.close();
	await tempDir.remove().catch(() => {});
}
