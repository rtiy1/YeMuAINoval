import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { disableProvider, enableProvider } from "@yemu/agent-runtime/capability";
import { clearCache as clearFsCache } from "@yemu/agent-runtime/capability/fs";
import {
	clearYemuExtensionCliRoots,
	injectYemuExtensionCliRoots,
} from "@yemu/agent-runtime/discovery/yemu-extension-roots";
import { discoverAgents } from "@yemu/agent-runtime/task/discovery";
import { removeWithRetries } from "@yemu/utils";

const YEMU_AGENT_MD = [
	"---",
	"name: yemu-test-agent",
	"description: YeMu-native test agent.",
	"---",
	"You are an YeMu task agent.",
].join("\n");

const YEMU_PLUGIN_AGENT_MD = [
	"---",
	"name: loom-verify-spec",
	"description: Plugin-shipped verification agent.",
	"---",
	"You verify the loom spec.",
].join("\n");

const CLAUDE_AGENT_MD = [
	"---",
	"name: cc-test-agent",
	"description: Test Claude Code agent.",
	"tools: Read, Grep, Glob, Bash",
	"model: sonnet",
	"color: purple",
	"---",
	"You are a Claude Code custom subagent.",
].join("\n");

async function writeYemuPluginAgent(home: string): Promise<void> {
	const userPluginsRoot = path.join(home, ".yemu", "plugins");
	const pluginRoot = path.join(userPluginsRoot, "node_modules", "loom");
	await fs.mkdir(path.join(pluginRoot, "agents"), { recursive: true });
	await fs.writeFile(
		path.join(pluginRoot, "package.json"),
		JSON.stringify({ name: "loom", version: "1.0.0", yemu: { version: "1.0.0" } }),
	);
	await fs.writeFile(
		path.join(userPluginsRoot, "package.json"),
		JSON.stringify({
			name: "yemu-plugins-root",
			version: "0.0.0",
			dependencies: { loom: "1.0.0" },
		}),
	);
	await fs.writeFile(path.join(pluginRoot, "agents", "loom-verify-spec.md"), YEMU_PLUGIN_AGENT_MD);
}

describe("discoverAgents", () => {
	let tempHome: string;
	let projectDir: string;

	beforeEach(async () => {
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-task-agent-discovery-"));
		projectDir = path.join(tempHome, "project");
		await fs.mkdir(projectDir, { recursive: true });
	});

	afterEach(async () => {
		enableProvider("yemu-plugins");
		clearYemuExtensionCliRoots();
		clearFsCache();
		await removeWithRetries(tempHome);
	});

	test("loads YeMu agents but skips Claude Code custom agents", async () => {
		await fs.mkdir(path.join(projectDir, ".yemu", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".yemu", "agents", "yemu-test-agent.md"), YEMU_AGENT_MD);

		await fs.mkdir(path.join(tempHome, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(tempHome, ".claude", "agents", "user-cc-test-agent.md"), CLAUDE_AGENT_MD);
		await fs.mkdir(path.join(projectDir, ".claude", "agents"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".claude", "agents", "project-cc-test-agent.md"), CLAUDE_AGENT_MD);

		const { agents, projectAgentsDir } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("yemu-test-agent");
		expect(names).not.toContain("cc-test-agent");
		expect(projectAgentsDir).toBe(path.join(projectDir, ".yemu", "agents"));
	});

	test("loads agents from YeMu npm plugins under <home>/.yemu/plugins/node_modules", async () => {
		await writeYemuPluginAgent(tempHome);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).toContain("loom-verify-spec");
	});

	test("excludes YeMu npm plugin agents when yemu-plugins is disabled", async () => {
		await writeYemuPluginAgent(tempHome);
		disableProvider("yemu-plugins");

		const { agents } = await discoverAgents(projectDir, tempHome);
		const names = agents.map(agent => agent.name);

		expect(names).not.toContain("loom-verify-spec");
	});

	test("CLI extension agents win over project `extensions:` settings on dedup", async () => {
		// listYemuExtensionRoots returns roots in source-precedence order
		// (CLI > project settings > user settings > installed plugins). Agents
		// must honor that order so the `task` surface dedups identically to
		// the skills/hooks/tools surface in discovery/yemu-plugins.ts.
		const cliExt = path.join(tempHome, "cli-ext");
		const projectExt = path.join(tempHome, "project-ext");
		await fs.mkdir(path.join(cliExt, "agents"), { recursive: true });
		await fs.mkdir(path.join(projectExt, "agents"), { recursive: true });
		await fs.writeFile(
			path.join(cliExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-cli", "---", "cli body"].join("\n"),
		);
		await fs.writeFile(
			path.join(projectExt, "agents", "collide.md"),
			["---", "name: collide", "description: from-project-settings", "---", "project body"].join("\n"),
		);

		await fs.mkdir(path.join(projectDir, ".yemu"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".yemu", "settings.json"), JSON.stringify({ extensions: [projectExt] }));
		injectYemuExtensionCliRoots([cliExt], tempHome, projectDir);

		const { agents } = await discoverAgents(projectDir, tempHome);
		const collide = agents.find(agent => agent.name === "collide");

		expect(collide).toBeDefined();
		expect(collide?.description).toBe("from-cli");
		expect(collide?.filePath).toBe(path.join(cliExt, "agents", "collide.md"));
	});
});
