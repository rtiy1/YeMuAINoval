import { describe, expect, it } from "bun:test";
import { InternalUrlRouter } from "@yemu/agent-runtime/internal-urls";

describe("YemuProtocolHandler", () => {
	it("treats yemu://docs as the documentation root", async () => {
		const resource = await InternalUrlRouter.instance().resolve("yemu://docs");

		expect(resource.content).toContain("# Documentation");
		expect(resource.content).toContain("tools/read.md");
	});

	it("resolves docs-prefixed documentation paths", async () => {
		const router = InternalUrlRouter.instance();
		const direct = await router.resolve("yemu://tools/read.md");
		const prefixed = await router.resolve("yemu://docs/tools/read.md");

		expect(prefixed.content).toBe(direct.content);
		expect(prefixed.content).toContain("# read");
	});
});
