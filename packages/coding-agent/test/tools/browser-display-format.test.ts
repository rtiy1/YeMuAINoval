import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@yemu/agent-runtime/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "@yemu/agent-runtime/modes/theme/theme";
import { toolRenderers } from "@yemu/agent-runtime/tools/renderers";

describe("browser renderer: display-only streaming formatting", () => {
	let theme: Theme;

	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: process.cwd() });
		theme = (await getThemeByName("dark"))!;
		expect(theme).toBeDefined();
		setThemeInstance(theme);
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	it("expands compact JavaScript without mutating the run source", () => {
		const source = "if (ready) {run();finish();}";
		const args = { action: "run", code: source };
		const rendered = Bun.stripANSI(
			toolRenderers.browser.renderCall(args, { expanded: true, isPartial: true }, theme).render(120).join("\n"),
		);

		expect(rendered).toContain("run();");
		expect(rendered).toContain("finish();");
		expect(rendered).not.toContain("run();finish();");
		expect(args.code).toBe(source);
	});
});
