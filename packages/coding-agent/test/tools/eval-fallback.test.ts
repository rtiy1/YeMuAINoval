import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@yemu/agent-runtime/config/settings";
import * as evalIndex from "@yemu/agent-runtime/eval";
import * as pyKernel from "@yemu/agent-runtime/eval/py/kernel";
import type { ToolSession } from "@yemu/agent-runtime/tools";
import { EvalTool } from "@yemu/agent-runtime/tools/eval";
import { resolveEvalBackends } from "@yemu/agent-runtime/tools/eval-backends";

let originalYemuPy: string | undefined;
let originalYemuJs: string | undefined;
let originalYemuRb: string | undefined;
let originalYemuJl: string | undefined;

function restoreEnv(name: "YEMU_PY" | "YEMU_JS" | "YEMU_RB" | "YEMU_JL", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}
function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
};

describe("EvalTool language dispatch", () => {
	beforeEach(() => {
		originalYemuPy = Bun.env.YEMU_PY;
		originalYemuJs = Bun.env.YEMU_JS;
		originalYemuRb = Bun.env.YEMU_RB;
		originalYemuJl = Bun.env.YEMU_JL;
		delete Bun.env.YEMU_PY;
		delete Bun.env.YEMU_JS;
		delete Bun.env.YEMU_RB;
		delete Bun.env.YEMU_JL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("YEMU_PY", originalYemuPy);
		restoreEnv("YEMU_JS", originalYemuJs);
		restoreEnv("YEMU_RB", originalYemuRb);
		restoreEnv("YEMU_JL", originalYemuJl);
	});

	it('dispatches to the JS backend when cell.language === "js"', async () => {
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-js", {
			language: "js",
			code: "const x = 1;",
		});

		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
		expect(pythonExecuteSpy).not.toHaveBeenCalled();
	});

	it('dispatches to the Python backend when cell.language === "py"', async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", {
			language: "py",
			code: "print('hi')",
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});

	it("dispatches each call to the backend named by its language", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", { language: "py", code: "x = 1" });
		await tool.execute("call-js", { language: "js", code: "const y = 2;" });

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects py cells when eval.py is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-py-disabled", {
				language: "py",
				code: "print('hi')",
			}),
		).rejects.toThrow(/eval\.py = false/);
	});

	it("rejects js cells when eval.js is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.js", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-js-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/eval\.js = false/);
	});

	it("uses settings for eval backends whose env flag is unset", () => {
		Bun.env.YEMU_PY = "1";
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		settings.set("eval.js", false);

		expect(resolveEvalBackends(makeSession(settings))).toEqual({
			python: true,
			js: false,
			ruby: false,
			julia: false,
		});
	});

	it("lets YEMU_JS disable js execution even when eval.js is enabled", async () => {
		Bun.env.YEMU_JS = "0";
		const settings = Settings.isolated();
		settings.set("eval.js", true);
		const tool = new EvalTool(makeSession(settings));

		await expect(
			tool.execute("call-js-env-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/YEMU_JS=0/);
	});
});
