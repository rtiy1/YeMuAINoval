export interface StoryFileRecord {
	path: string;
	title: string;
	category: string;
	content?: string;
	updatedAt?: string;
}

interface StoryFileContext {
	inventory?: unknown;
	loaded?: unknown;
}

export interface StoryFileWorkspace {
	list(prefix?: string): StoryFileRecord[];
	read(path: string): Promise<StoryFileRecord>;
	write(file: StoryFileRecord): StoryFileRecord;
	edit(path: string, oldText: string, newText: string, replaceAll?: boolean): Promise<StoryFileRecord>;
	written(): StoryFileRecord[];
}

const MAX_STORY_FILES = 80;
const MAX_STORY_FILE_CHARS = 50_000;

function cleanText(value: unknown, limit: number): string {
	return String(value ?? "").trim().slice(0, limit);
}

export function normalizeStoryFilePath(value: unknown): string {
	const raw = String(value ?? "").replaceAll("\\", "/").trim().slice(0, 240);
	if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) throw new Error("作品文件路径必须是相对路径");
	const parts = raw.split("/").filter(Boolean);
	if (!parts.length || parts.some(part => part === "." || part === ".." || part.includes("\0"))) {
		throw new Error("作品文件路径无效");
	}
	return parts.join("/");
}

function fileRecord(value: unknown, requireContent = false): StoryFileRecord | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const item = value as Record<string, unknown>;
	let path: string;
	try {
		path = normalizeStoryFilePath(item.path ?? item.file);
	} catch {
		return null;
	}
	const fallbackTitle = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") ?? "作品文件";
	const title = cleanText(item.title || fallbackTitle, 160);
	const category = cleanText(item.category || path.split("/")[0] || "资料", 40);
	const contentValue = item.content ?? item.body ?? item.text;
	const content = typeof contentValue === "string"
		? contentValue.replace(/\r\n?/g, "\n").trim().slice(0, MAX_STORY_FILE_CHARS)
		: undefined;
	if (!title || !category || (requireContent && !content)) return null;
	return {
		path,
		title,
		category,
		...(content !== undefined ? { content } : {}),
		...(typeof item.updatedAt === "string" ? { updatedAt: item.updatedAt } : {}),
	};
}

function contextFiles(payload: Record<string, unknown>): StoryFileContext {
	const writingContext = payload.writing_context;
	if (!writingContext || typeof writingContext !== "object" || Array.isArray(writingContext)) return {};
	const storyFiles = (writingContext as Record<string, unknown>).storyFiles;
	return storyFiles && typeof storyFiles === "object" && !Array.isArray(storyFiles)
		? (storyFiles as StoryFileContext)
		: {};
}

export function createStoryFileWorkspace(
	payload: Record<string, unknown>,
	readThrough?: (path: string) => Promise<StoryFileRecord | null>,
): StoryFileWorkspace {
	const files = new Map<string, StoryFileRecord>();
	const changes = new Map<string, StoryFileRecord>();
	const context = contextFiles(payload);
	for (const value of Array.isArray(context.inventory) ? context.inventory.slice(0, MAX_STORY_FILES) : []) {
		const record = fileRecord(value);
		if (record) files.set(record.path, record);
	}
	for (const value of Array.isArray(context.loaded) ? context.loaded.slice(0, MAX_STORY_FILES) : []) {
		const record = fileRecord(value, true);
		if (record) files.set(record.path, { ...files.get(record.path), ...record });
	}

	async function read(pathValue: string): Promise<StoryFileRecord> {
		const path = normalizeStoryFilePath(pathValue);
		const current = files.get(path);
		if (current?.content !== undefined) return { ...current };
		const loaded = readThrough ? fileRecord(await readThrough(path), true) : null;
		if (!loaded || loaded.path !== path) throw new Error(`作品文件不存在：${path}`);
		const merged = { ...current, ...loaded };
		files.set(path, merged);
		return { ...merged };
	}

	function write(value: StoryFileRecord): StoryFileRecord {
		const record = fileRecord(value, true);
		if (!record) throw new Error("作品文件必须包含有效的相对路径、标题和内容");
		if (!files.has(record.path) && files.size >= MAX_STORY_FILES) throw new Error(`一次最多暂存 ${MAX_STORY_FILES} 个作品文件`);
		const next = { ...files.get(record.path), ...record };
		files.set(record.path, next);
		changes.set(record.path, next);
		return { ...next };
	}

	return {
		list(prefixValue = "") {
			const prefix = String(prefixValue || "").replaceAll("\\", "/").replace(/^\/+/, "").trim();
			return [...files.values()]
				.filter(item => !prefix || item.path.startsWith(prefix))
				.map(({ content: _content, ...item }) => ({ ...item }))
				.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
		},
		read,
		write,
		async edit(pathValue, oldText, newText, replaceAll = false) {
			if (!oldText) throw new Error("old_text 不能为空");
			const current = await read(pathValue);
			const content = current.content ?? "";
			const occurrences = content.split(oldText).length - 1;
			if (!occurrences) throw new Error("作品文件中没有找到 old_text");
			if (!replaceAll && occurrences > 1) throw new Error("old_text 出现多次；请提供更精确的文本或启用 replace_all");
			const updated = replaceAll ? content.replaceAll(oldText, newText) : content.replace(oldText, newText);
			return write({ ...current, content: updated });
		},
		written() {
			return [...changes.values()].map(item => ({ ...item }));
		},
	};
}

export function mergeStoryFileArtifacts(artifacts: unknown, writtenFiles: StoryFileRecord[]): Record<string, unknown> | undefined {
	const base = artifacts && typeof artifacts === "object" && !Array.isArray(artifacts)
		? { ...(artifacts as Record<string, unknown>) }
		: {};
	const existing = Array.isArray(base.documents) ? base.documents : Array.isArray(base.files) ? base.files : [];
	const documents = new Map<string, StoryFileRecord>();
	for (const value of existing) {
		const record = fileRecord(value, true);
		if (record) documents.set(record.path, record);
	}
	for (const value of writtenFiles) {
		const record = fileRecord(value, true);
		if (record) documents.set(record.path, record);
	}
	if (!documents.size) return Object.keys(base).length ? base : undefined;
	delete base.files;
	base.documents = [...documents.values()].slice(0, MAX_STORY_FILES);
	return base;
}
