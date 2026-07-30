import { describe, expect, it } from "bun:test";
import { CONFIG_DIR_NAME, parseArgs } from "@yemu/agent-runtime/extensibility/legacy-agent-runtime-shim";

describe("legacy shim CLI exports", () => {
	it("re-exports parseArgs and CONFIG_DIR_NAME from the legacy package root", () => {
		expect(CONFIG_DIR_NAME).toBe(".yemu");
		expect(parseArgs(["hello"]).messages).toEqual(["hello"]);
	});
});
