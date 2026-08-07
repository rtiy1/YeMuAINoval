// Per-user file workspace: projects and chapters live as real files on disk
// so the embedded Claude Code CLI can read and edit them directly.
//
// Layout (under server/data):
//   config/<userId>/              CLAUDE_CONFIG_DIR for the CLI process
//   workspaces/<userId>/          workspace root
//     .claude/skills/<name>/      installed market skills
//     <projectId>/                one folder per project (CLI working dir)
//       CLAUDE.md                 generated project context for the agent
//       project.json              project metadata
//       .yemu/index.json          chapter order/state + story file categories
//       .yemu/history/<chapter>.jsonl
//       <chapter files>.md        "001-第一章.md" style chapter files
//       <story files>.md          outlines, characters, settings, notes

import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.STORY_DATA_FILE
	? path.resolve(path.dirname(process.env.STORY_DATA_FILE))
	: path.join(serverDir, "data");
const workspaceRootDir = () => path.join(dataDir, "workspaces");
const configRootDir = () => path.join(dataDir, "config");
const CLI_VERSION = "999.0.0-restored";

export const CHAPTER_PATTERN = /^(\d{3,4})-([^/]+)\.md$/;
export const STORY_FILE_PATTERN = /^(大纲|人物|设定|资料|伏笔)-?[^/]*\.md$/;

export function workspacePathForUser(userId) {
	return path.join(workspaceRootDir(), String(userId));
}

export function configPathForUser(userId) {
	return path.join(configRootDir(), String(userId));
}

export function projectPathFor(userId, projectId) {
	return path.join(workspacePathForUser(userId), String(projectId));
}

function idForTitle(title) {
	const slug = String(title || "")
		.trim()
		.replace(/[\\/:*?"<>|\s]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const suffix = createHash("sha1")
		.update(String(title || ""))
		.digest("hex")
		.slice(0, 6);
	return slug ? `${slug}-${suffix}` : `project-${suffix}`;
}

function chapterFileName(position, title) {
	const number = String(Math.max(1, Math.round(Number(position) || 1))).padStart(3, "0");
	const safeTitle =
		String(title || "")
			.trim()
			.replace(/[\\/:*?"<>|\n]+/g, " ")
			.replace(/\s+/g, " ")
			.slice(0, 60) || "未命名章节";
	return `${number}-${safeTitle}.md`;
}

function chapterTitleFromFile(fileName) {
	const match = CHAPTER_PATTERN.exec(fileName);
	if (!match) return fileName.replace(/\.md$/u, "");
	return match[2].trim();
}

function wordCount(content) {
	return String(content || "").replace(/\s/g, "").length;
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return fallback;
	}
}

async function writeJson(file, value) {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function ensureUserWorkspace(userId) {
	return Promise.all([
		mkdir(workspacePathForUser(userId), { recursive: true }),
		mkdir(configPathForUser(userId), { recursive: true }),
		mkdir(path.join(workspacePathForUser(userId), ".claude", "skills"), { recursive: true }),
	]);
}

/**
 * Seed the CLI global config so a fresh spawn skips onboarding, API key
 * approval and trust dialogs and lands directly in the REPL.
 */
export async function seedCliConfig(userId, { apiKey = "", trustedPaths = [] } = {}) {
	await ensureUserWorkspace(userId);
	const configDir = configPathForUser(userId);
	const globalConfigFile = path.join(configDir, ".claude.json");
	const existing = await readJson(globalConfigFile, {});
	const projects = { ...(existing.projects || {}) };
	for (const projectPath of trustedPaths) {
		projects[projectPath] = { ...(projects[projectPath] || {}), hasTrustDialogAccepted: true };
	}
	const approved = Array.isArray(existing.customApiKeyResponses?.approved)
		? [...existing.customApiKeyResponses.approved]
		: [];
	if (apiKey && !approved.includes(apiKey.slice(-20))) approved.push(apiKey.slice(-20));
	await writeJson(globalConfigFile, {
		...existing,
		theme: existing.theme || "dark",
		hasCompletedOnboarding: true,
		lastOnboardingVersion: CLI_VERSION,
		customApiKeyResponses: {
			approved,
			rejected: Array.isArray(existing.customApiKeyResponses?.rejected)
				? existing.customApiKeyResponses.rejected
				: [],
		},
		projects,
	});
	await mkdir(path.join(configDir, ".claude"), { recursive: true });
	const settingsFile = path.join(configDir, ".claude", "settings.json");
	if (!(await stat(settingsFile).catch(() => null))) {
		await writeJson(settingsFile, {});
	}
}

export async function listProjects(userId) {
	const root = workspacePathForUser(userId);
	const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
	const projects = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const projectDir = path.join(root, entry.name);
		const meta = await readJson(path.join(projectDir, "project.json"), null);
		if (!meta?.title) continue;
		const chapters = await listChapterFiles(projectDir);
		let words = 0;
		let lastUpdatedAt = meta.updatedAt || null;
		for (const chapter of chapters) {
			words += chapter.words;
			if (chapter.updatedAt && (!lastUpdatedAt || chapter.updatedAt > lastUpdatedAt))
				lastUpdatedAt = chapter.updatedAt;
		}
		projects.push({
			id: entry.name,
			title: meta.title,
			type: meta.type || "长篇",
			genre: meta.genre || "",
			style: meta.style || "",
			premise: meta.premise || "",
			status: meta.status || "构思中",
			isActive: meta.isActive === true,
			summary: meta.summary || "",
			chapters: chapters.length,
			words,
			createdAt: meta.createdAt || null,
			updatedAt: lastUpdatedAt,
		});
	}
	return projects.sort(
		(left, right) =>
			String(right.isActive) - String(left.isActive) ||
			String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
	);
}

export async function getProject(userId, projectId) {
	const projectDir = projectPathFor(userId, projectId);
	const meta = await readJson(path.join(projectDir, "project.json"), null);
	if (!meta?.title) return null;
	const chapters = await listChapterFiles(projectDir);
	let words = 0;
	let lastUpdatedAt = meta.updatedAt || null;
	for (const chapter of chapters) {
		words += chapter.words;
		if (chapter.updatedAt && (!lastUpdatedAt || chapter.updatedAt > lastUpdatedAt)) lastUpdatedAt = chapter.updatedAt;
	}
	return {
		id: projectId,
		title: meta.title,
		type: meta.type || "长篇",
		genre: meta.genre || "",
		style: meta.style || "",
		premise: meta.premise || "",
		status: meta.status || "构思中",
		isActive: meta.isActive === true,
		summary: meta.summary || "",
		chapters: chapters.length,
		words,
		createdAt: meta.createdAt || null,
		updatedAt: lastUpdatedAt,
	};
}

export async function createProject(userId, input = {}) {
	const title = String(input.title || "").trim();
	if (!title) throw new Error("作品标题不能为空");
	await ensureUserWorkspace(userId);
	const now = new Date().toISOString();
	const id = idForTitle(title);
	const projectDir = projectPathFor(userId, id);
	await mkdir(projectDir, { recursive: true });
	await mkdir(path.join(projectDir, ".yemu", "history"), { recursive: true });
	const meta = {
		title,
		type: input.type || "长篇",
		genre: input.genre || "现代言情",
		style: input.style || "",
		premise: input.premise || "",
		status: input.status || "构思中",
		isActive: input.isActive === true,
		summary: input.summary || "",
		createdAt: now,
		updatedAt: now,
	};
	await writeJson(path.join(projectDir, "project.json"), meta);
	await writeJson(path.join(projectDir, ".yemu", "index.json"), { chapters: {}, files: {} });
	const chapter = await createChapter(userId, id, "第一章");
	await writeCliContext(userId, id, {});
	await seedCliConfig(userId, { trustedPaths: [projectDir] });
	return { project: await getProject(userId, id), chapter };
}

export async function updateProject(userId, projectId, updates) {
	const projectDir = projectPathFor(userId, projectId);
	const meta = await readJson(path.join(projectDir, "project.json"), null);
	if (!meta?.title) throw new Error("作品不存在");
	for (const key of ["title", "type", "genre", "style", "premise", "status", "summary"]) {
		if (updates[key] !== undefined) meta[key] = updates[key];
	}
	if (updates.isActive !== undefined) meta.isActive = updates.isActive === true;
	meta.updatedAt = new Date().toISOString();
	await writeJson(path.join(projectDir, "project.json"), meta);
	return getProject(userId, projectId);
}

export async function deleteProject(userId, projectId) {
	const projectDir = projectPathFor(userId, projectId);
	await rm(projectDir, { recursive: true, force: true });
}

async function readProjectIndex(projectDir) {
	return readJson(path.join(projectDir, ".yemu", "index.json"), { chapters: {}, files: {} });
}

async function listChapterFiles(projectDir) {
	const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
	const index = await readProjectIndex(projectDir);
	const chapters = [];
	for (const entry of entries) {
		if (!entry.isFile() || !CHAPTER_PATTERN.test(entry.name)) continue;
		const id = entry.name.replace(/\.md$/u, "");
		const file = path.join(projectDir, entry.name);
		const info = index.chapters?.[id] || {};
		const content = await readFile(file, "utf8").catch(() => "");
		const fileStat = await stat(file).catch(() => null);
		chapters.push({
			id,
			title: info.title || chapterTitleFromFile(entry.name),
			state: info.state || "draft",
			words: wordCount(content),
			createdAt: fileStat?.birthtime?.toISOString?.() || null,
			updatedAt: fileStat?.mtime?.toISOString?.() || null,
		});
	}
	const positionOf = chapter =>
		index.chapters?.[chapter.id]?.position ?? (Number.parseInt(chapter.id, 10) || Number.MAX_SAFE_INTEGER);
	return chapters.sort((left, right) => positionOf(left) - positionOf(right));
}

export async function listChapters(userId, projectId) {
	const projectDir = projectPathFor(userId, projectId);
	if (!(await stat(projectDir).catch(() => null))) return [];
	return listChapterFiles(projectDir);
}

export async function createChapter(userId, projectId, title) {
	const projectDir = projectPathFor(userId, projectId);
	const chapters = await listChapterFiles(projectDir);
	const index = await readProjectIndex(projectDir);
	const position =
		chapters.reduce(
			(max, chapter) =>
				Math.max(max, index.chapters?.[chapter.id]?.position ?? (Number(chapter.id.split("-")[0]) || 0)),
			0,
		) + 1;
	const fileName = chapterFileName(position, title || `第 ${position} 章`);
	const id = fileName.replace(/\.md$/u, "");
	const file = path.join(projectDir, fileName);
	if (await stat(file).catch(() => null)) throw new Error("同名章节已存在");
	await writeFile(file, "", "utf8");
	index.chapters[id] = { position, title: title || `第 ${position} 章`, state: "draft" };
	await writeJson(path.join(projectDir, ".yemu", "index.json"), index);
	const content = "";
	return {
		chapter: {
			id,
			title: index.chapters[id].title,
			state: "draft",
			words: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		},
		content,
	};
}

export async function updateChapter(userId, projectId, chapterId, updates) {
	const projectDir = projectPathFor(userId, projectId);
	const file = path.join(projectDir, `${chapterId}.md`);
	if (!(await stat(file).catch(() => null))) throw new Error("章节不存在");
	const index = await readProjectIndex(projectDir);
	const entry = index.chapters?.[chapterId] || {};
	if (updates.title !== undefined) {
		const title = String(updates.title || "").trim();
		if (!title) throw new Error("章节标题不能为空");
		const position = entry.position ?? (Number(chapterId.split("-")[0]) || 1);
		const nextFile = chapterFileName(position, title);
		const nextId = nextFile.replace(/\.md$/u, "");
		if (nextId !== chapterId && (await stat(path.join(projectDir, nextFile)).catch(() => null))) {
			throw new Error("同名章节已存在");
		}
		await rename(file, path.join(projectDir, nextFile));
		delete index.chapters[chapterId];
		index.chapters[nextId] = { ...entry, title };
		await writeJson(path.join(projectDir, ".yemu", "index.json"), index);
		return getChapterPublic(projectDir, nextId, nextFile);
	}
	if (updates.state !== undefined) {
		if (!["draft", "current", "done"].includes(updates.state)) throw new Error("无效的章节状态");
		entry.state = updates.state;
		index.chapters[chapterId] = entry;
		await writeJson(path.join(projectDir, ".yemu", "index.json"), index);
	}
	return getChapterPublic(projectDir, chapterId, file);
}

async function getChapterPublic(projectDir, chapterId, file) {
	const index = await readProjectIndex(projectDir);
	const entry = index.chapters?.[chapterId] || {};
	const content = await readFile(file, "utf8").catch(() => "");
	const fileStat = await stat(file).catch(() => null);
	return {
		chapter: {
			id: chapterId,
			title: entry.title || chapterTitleFromFile(path.basename(file)),
			state: entry.state || "draft",
			words: wordCount(content),
			createdAt: fileStat?.birthtime?.toISOString?.() || null,
			updatedAt: fileStat?.mtime?.toISOString?.() || null,
		},
	};
}

export async function deleteChapter(userId, projectId, chapterId) {
	const projectDir = projectPathFor(userId, projectId);
	const file = path.join(projectDir, `${chapterId}.md`);
	await rm(file, { force: true });
	const index = await readProjectIndex(projectDir);
	if (index.chapters?.[chapterId]) {
		delete index.chapters[chapterId];
		await writeJson(path.join(projectDir, ".yemu", "index.json"), index);
	}
}

export async function readChapterDraft(userId, projectId, chapterId) {
	const file = path.join(projectPathFor(userId, projectId), `${chapterId}.md`);
	return readFile(file, "utf8").catch(() => "");
}

export async function writeChapterDraft(userId, projectId, chapterId, content) {
	const projectDir = projectPathFor(userId, projectId);
	const file = path.join(projectDir, `${chapterId}.md`);
	if (!(await stat(file).catch(() => null))) throw new Error("章节不存在");
	await writeFile(file, String(content ?? ""), "utf8");
	return {
		chapter: (await getChapterPublic(projectDir, chapterId, file)).chapter,
		project: await getProject(userId, projectId),
	};
}

export async function listChapterHistory(userId, projectId, chapterId) {
	const historyDir = path.join(projectPathFor(userId, projectId), ".yemu", "history");
	const file = path.join(historyDir, `${chapterId}.jsonl`);
	const text = await readFile(file, "utf8").catch(() => "");
	return text
		.split("\n")
		.filter(Boolean)
		.map(line => {
			try {
				const snapshot = JSON.parse(line);
				return {
					id: snapshot.id,
					chapterId,
					content: snapshot.content,
					createdAt: snapshot.createdAt,
				};
			} catch {
				return null;
			}
		})
		.filter(Boolean)
		.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

export async function createChapterHistory(userId, projectId, chapterId, content) {
	const historyDir = path.join(projectPathFor(userId, projectId), ".yemu", "history");
	await mkdir(historyDir, { recursive: true });
	const file = path.join(historyDir, `${chapterId}.jsonl`);
	const snapshot = {
		id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		chapterId,
		content: String(content ?? ""),
		createdAt: new Date().toISOString(),
	};
	await writeFile(file, `${JSON.stringify(snapshot)}\n`, { flag: "a" });
	return snapshot;
}

/**
 * Non-chapter markdown files in the project folder, categorized by a
 * 大纲/人物/设定 prefix so the agent's written material shows up in rails.
 */
export async function listStoryFiles(userId, projectId) {
	const projectDir = projectPathFor(userId, projectId);
	const entries = await readdir(projectDir, { withFileTypes: true }).catch(() => []);
	const files = [];
	for (const entry of entries) {
		if (
			!entry.isFile() ||
			!entry.name.endsWith(".md") ||
			CHAPTER_PATTERN.test(entry.name) ||
			entry.name === "CLAUDE.md"
		)
			continue;
		const file = path.join(projectDir, entry.name);
		const content = await readFile(file, "utf8").catch(() => "");
		const fileStat = await stat(file).catch(() => null);
		files.push({
			id: `file:${entry.name}`,
			name: entry.name.replace(/\.md$/u, ""),
			kind: entry.name.startsWith("大纲")
				? "大纲"
				: entry.name.startsWith("人物")
					? "人物"
					: entry.name.startsWith("设定")
						? "设定"
						: "资料",
			words: wordCount(content),
			createdAt: fileStat?.birthtime?.toISOString?.() || null,
			updatedAt: fileStat?.mtime?.toISOString?.() || null,
		});
	}
	return files.sort(
		(left, right) =>
			String(left.kind).localeCompare(String(right.kind)) || String(left.name).localeCompare(String(right.name)),
	);
}

export async function readStoryFile(userId, projectId, name) {
	const safe = path.basename(String(name || ""));
	if (!safe.endsWith(".md")) throw new Error("无效的文件");
	return readFile(path.join(projectPathFor(userId, projectId), safe), "utf8").catch(() => "");
}

export async function writeStoryFile(userId, projectId, name, content) {
	const safe = path.basename(String(name || ""));
	if (!safe.endsWith(".md")) throw new Error("无效的文件");
	await writeFile(path.join(projectPathFor(userId, projectId), safe), String(content ?? ""), "utf8");
}

/**
 * Regenerate CLAUDE.md for a project so the CLI agent always sees the
 * current novel context: metadata, chapter list, memories and foreshadows.
 */
export async function writeCliContext(userId, projectId, context = {}) {
	const projectDir = projectPathFor(userId, projectId);
	const meta = await readJson(path.join(projectDir, "project.json"), null);
	if (!meta?.title) return;
	const chapters = await listChapterFiles(projectDir);
	const storyFiles = await listStoryFiles(userId, projectId);
	const memories = Array.isArray(context.memories)
		? context.memories.filter(memory => memory.status !== "archived")
		: [];
	const foreshadows = Array.isArray(context.foreshadows)
		? context.foreshadows.filter(item => item.status !== "resolved" && item.status !== "abandoned")
		: [];

	const lines = [
		`# 《${meta.title}》创作上下文`,
		"",
		"你是这部作品的写作助手。以下信息在每次会话开始时自动载入，请遵守其中所有约定。",
		"",
		"## 作品信息",
		`- 类型：${meta.type || "长篇"}`,
		`- 题材：${meta.genre || ""}`,
		`- 风格：${meta.style || ""}`,
		...(meta.premise ? [`- 主线：${meta.premise}`] : []),
		"",
		"## 正文章节",
		...(chapters.length
			? chapters.map(
					chapter =>
						`- \`${chapter.id}.md\` ${chapter.title}${chapter.state === "done" ? "（已完成）" : ""}${chapter.state === "current" ? "（当前）" : ""}`,
				)
			: ["（暂无章节）"]),
		"",
		"## 作品资料文件",
		...(storyFiles.length
			? storyFiles.map(file => `- \`${file.name}.md\`（${file.kind}）`)
			: ["（暂无；可按需创建）"]),
		"",
		"## 作品记忆",
		...(memories.length
			? memories.map(
					memory =>
						`- [${memory.type}] ${memory.title}${memory.characterName ? `（${memory.characterName}）` : ""}：${String(memory.content || "").slice(0, 200)}`,
				)
			: ["（暂无）"]),
		"",
		"## 未回收伏笔",
		...(foreshadows.length
			? foreshadows.map(
					item =>
						`- ${item.title}（${item.category || "未分类"}，重要性 ${item.importance || 3}）${item.plantedChapter ? `，埋入 ${item.plantedChapter}` : ""}${item.plan ? `：${String(item.plan).slice(0, 120)}` : ""}`,
				)
			: ["（暂无）"]),
		"",
		"## 写作约定",
		"- 修改正文前先与作者确认要改什么、怎么改。",
		"- 每章正文放在章节文件里，不要新建重复章节文件。",
		"- 新建大纲、人物、设定资料时使用对应的文件名前缀（如 `人物-角色名.md`）。",
		"",
	];
	await writeFile(path.join(projectDir, "CLAUDE.md"), lines.join("\n"), "utf8");
}

export async function workspaceStats(userId) {
	const projects = await listProjects(userId);
	return {
		projectCount: projects.length,
		chapterCount: projects.reduce((sum, project) => sum + project.chapters, 0),
		totalWords: projects.reduce((sum, project) => sum + project.words, 0),
		projects,
	};
}

/**
 * Copy an installed skill package into the user workspace so the CLI
 * discovers it under .claude/skills/.
 */
export async function installSkillForUser(userId, skillFolder) {
	const targetRoot = path.join(workspacePathForUser(userId), ".claude", "skills");
	await mkdir(targetRoot, { recursive: true });
	const name = path.basename(skillFolder);
	const target = path.join(targetRoot, name);
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	const entries = await readdir(skillFolder, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isDirectory()) continue;
		await copyFile(path.join(skillFolder, entry.name), path.join(target, entry.name));
	}
	return name;
}

export async function removeSkillForUser(userId, skillName) {
	const safe = path.basename(String(skillName || ""));
	await rm(path.join(workspacePathForUser(userId), ".claude", "skills", safe), { recursive: true, force: true });
}

export async function listUserSkills(userId) {
	const skillsDir = path.join(workspacePathForUser(userId), ".claude", "skills");
	const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
	return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
}
