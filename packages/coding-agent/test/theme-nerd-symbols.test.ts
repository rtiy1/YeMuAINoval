import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getThemeByName } from "@yemu/agent-runtime/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@yemu/utils";

const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");

let tempAgentDir: string | undefined;
let originalAgentDir = "";
let originalAgentDirEnv: string | undefined;

afterEach(async () => {
	if (tempAgentDir === undefined) return;
	setAgentDir(originalAgentDir);
	if (originalAgentDirEnv === undefined) {
		delete process.env.YEMU_CODING_AGENT_DIR;
	} else {
		process.env.YEMU_CODING_AGENT_DIR = originalAgentDirEnv;
	}
	await removeWithRetries(tempAgentDir);
	tempAgentDir = undefined;
});

it("uses the Nerd Fonts v3 Material Design session icon", async () => {
	originalAgentDir = getAgentDir();
	originalAgentDirEnv = process.env.YEMU_CODING_AGENT_DIR;
	tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-nerd-symbols-"));
	setAgentDir(tempAgentDir);

	const dark = await Bun.file(DARK_THEME_PATH).json();
	const customThemeName = "nerd-symbols";
	await Bun.write(
		path.join(getCustomThemesDir(), `${customThemeName}.json`),
		JSON.stringify({ ...dark, name: customThemeName, symbols: { ...dark.symbols, preset: "nerd" } }),
	);

	const theme = await getThemeByName(customThemeName);
	expect(theme?.symbol("icon.session")).toBe("\u{f0051}");
});
