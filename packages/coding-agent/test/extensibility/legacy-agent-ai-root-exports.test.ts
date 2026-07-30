import { describe, expect, it } from "bun:test";
import {
	isContextOverflow,
	parseJsonWithRepair,
	parseStreamingJson,
	repairJson,
} from "@yemu/agent-runtime/extensibility/legacy-model-runtime-shim";
import type { AssistantMessage } from "@yemu/model-runtime";

// Issue #6859: yemu extensions import runtime helpers from the `@yemu/model-runtime`
// (aliased to `@yemu/model-runtime`) package root that yemu's barrel no longer forwards.
// `isContextOverflow` moved under `@yemu/model-runtime/error` and the JSON-repair
// helpers moved to `@yemu/utils`, so `export * from "@yemu/model-runtime"` left
// them off the shim surface and a named import tripped Bun's static
// "No matching export" check during plugin validation (e.g.
// `yemu plugin install yemu-blackhole`). This pins the bridged root surface so it
// cannot silently regress the way #6583 / #6648 did one symbol at a time.
function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("legacy model-runtime shim root exports", () => {
	it("re-exports isContextOverflow with its classification behavior", () => {
		expect(typeof isContextOverflow).toBe("function");
		expect(isContextOverflow(createErrorMessage("prompt is too long: 300000 tokens > 200000 maximum"))).toBe(true);
		expect(isContextOverflow(createErrorMessage("400 Bad Request: invalid API key"))).toBe(false);
	});

	it("re-exports the JSON-repair helpers that upstream exposed at the model-runtime root", () => {
		// repairJson escapes a raw control char inside a string so JSON.parse stops throwing.
		const broken = `{"a": "b${String.fromCharCode(1)}c"}`;
		expect(() => JSON.parse(broken)).toThrow();
		expect(JSON.parse(repairJson(broken))).toEqual({ a: "b\u0001c" });
		// parseJsonWithRepair tolerates trailing commas / unquoted keys.
		expect(parseJsonWithRepair<{ a: number }>("{a: 1,}")).toEqual({ a: 1 });
		// parseStreamingJson completes a truncated object at the streaming edge.
		expect(parseStreamingJson<{ a: number }>('{"a": 1')).toEqual({ a: 1 });
	});
});
