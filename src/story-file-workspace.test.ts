import assert from "node:assert/strict";
import test from "node:test";
import {
	createStoryFileWorkspace,
	mergeStoryFileArtifacts,
	normalizeStoryFilePath,
} from "./story-file-workspace";

const payload = {
	writing_context: {
		storyFiles: {
			inventory: [
				{ path: "大纲/大纲.md", title: "全书大纲", category: "大纲" },
				{ path: "追踪/伏笔.md", title: "伏笔", category: "追踪" },
			],
			loaded: [{ path: "大纲/大纲.md", title: "全书大纲", category: "大纲", content: "# 大纲\n\n旧港谜案。" }],
		},
	},
};

test("story file paths stay inside the virtual project workspace", () => {
	assert.equal(normalizeStoryFilePath("设定\\人物.md"), "设定/人物.md");
	assert.throws(() => normalizeStoryFilePath("../其他用户/秘密.md"), /路径/);
	assert.throws(() => normalizeStoryFilePath("C:/server/.env"), /相对路径/);
});

test("story file workspace can read through and edit an unloaded file", async () => {
	const workspace = createStoryFileWorkspace(payload, async (path) => path === "追踪/伏笔.md"
		? { path, title: "伏笔", category: "追踪", content: "第三封信尚未回收。" }
		: null);
	assert.deepEqual(workspace.list("追踪/").map(item => item.path), ["追踪/伏笔.md"]);
	const edited = await workspace.edit("追踪/伏笔.md", "尚未回收", "已在第十章回收");
	assert.equal(edited.content, "第三封信已在第十章回收。");
	assert.equal(workspace.written().length, 1);
});

test("independent writes merge multiple files without repeating them in the final response", () => {
	const workspace = createStoryFileWorkspace(payload);
	workspace.write({ path: "设定/人物.md", title: "人物", category: "设定", content: "林默，记者。" });
	workspace.write({ path: "设定/地点.md", title: "地点", category: "设定", content: "旧港灯塔。" });
	workspace.write({ path: "设定/人物.md", title: "人物", category: "设定", content: "林默，失踪记者。" });
	const artifacts = mergeStoryFileArtifacts({ project: { genre: "悬疑" } }, workspace.written());
	assert.equal((artifacts?.documents as unknown[]).length, 2);
	assert.equal((artifacts?.documents as Array<{ path: string; content: string }>).find(item => item.path === "设定/人物.md")?.content, "林默，失踪记者。");
});
