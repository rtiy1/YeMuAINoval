import { afterEach, describe, expect, it, vi } from "bun:test";
import { applyProviderGlobalsFromSettings } from "@yemu/agent-runtime/config/provider-globals";
import * as imageGen from "@yemu/agent-runtime/tools/image-gen";
import * as webSearch from "@yemu/agent-runtime/web/search";

describe("applyProviderGlobalsFromSettings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reapplies valid web and image provider globals from cwd-scoped settings", () => {
		const excludeSpy = vi.spyOn(webSearch, "setExcludedSearchProviders").mockImplementation(() => {});
		const orderSpy = vi.spyOn(webSearch, "setSearchProviderOrder").mockImplementation(() => {});
		const imageOrderSpy = vi.spyOn(imageGen, "setImageProviderOrder").mockImplementation(() => {});

		applyProviderGlobalsFromSettings({
			get(path: "providers.webSearchOrder" | "providers.webSearchExclude" | "providers.imageOrder"): unknown {
				const values: Record<string, unknown> = {
					"providers.webSearchOrder": ["perplexity", "not-a-provider", "exa"],
					"providers.webSearchExclude": ["exa", "not-a-provider", "gemini"],
					"providers.imageOrder": ["xai", 42, "gemini"],
				};
				return values[path];
			},
		});

		expect(orderSpy).toHaveBeenCalledWith(["perplexity", "exa"]);
		expect(excludeSpy).toHaveBeenCalledWith(["exa", "gemini"]);
		expect(imageOrderSpy).toHaveBeenCalledWith(["xai", "gemini"]);
	});
});
