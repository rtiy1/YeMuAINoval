import { afterEach, describe, expect, it, vi } from "bun:test";
import * as yemuCodingAgent from "@yemu/agent-runtime";
import { GreenCommand } from "@yemu/agent-runtime/extensibility/custom-commands/bundled/ci-green";
import type { CustomCommandAPI } from "@yemu/agent-runtime/extensibility/custom-commands/types";
import type { HookCommandContext } from "@yemu/agent-runtime/extensibility/hooks/types";
import type * as TypeBox from "@yemu/agent-runtime/extensibility/typebox";
import * as git from "@yemu/agent-runtime/utils/git";
import * as arktype from "arktype";
import * as zod from "zod/v4";

afterEach(() => {
	vi.restoreAllMocks();
});

function createApi(): CustomCommandAPI {
	return {
		cwd: "/tmp/test",
		exec: async () => ({
			stdout: "",
			stderr: "",
			code: 0,
			killed: false,
		}),
		typebox: {} as unknown as typeof TypeBox,
		arktype,
		zod,
		yemu: yemuCodingAgent,
	};
}

describe("GreenCommand", () => {
	it("includes tag instructions when HEAD has a tag", async () => {
		vi.spyOn(git.ref, "tags").mockResolvedValue(["v0.1.0-alpha2"]);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).toContain("v0.1.0-alpha2");
		expect(result).not.toContain("timeouts due to the harnesses");
	});

	it("omits tag instructions when HEAD is not tagged", async () => {
		vi.spyOn(git.ref, "tags").mockResolvedValue([]);
		const command = new GreenCommand(createApi());

		const result = await command.execute([], {} as HookCommandContext);

		expect(result).not.toContain("v0.1.0-alpha2");
	});
});
