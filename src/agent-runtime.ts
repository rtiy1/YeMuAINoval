import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@yemu/agent-core/agent";
import type { AgentEvent, AgentTool } from "@yemu/agent-core/types";
import { buildModel } from "@yemu/model-catalog/build";
import { type AssistantMessage, type Effort, type Model, z } from "@yemu/model-runtime";
import { render } from "@yemu/utils/prompt";
import agentRequestTemplate from "./prompts/agent-request.md" with { type: "text" };
import agentSystemTemplate from "./prompts/agent-system.md" with { type: "text" };
import compactRequestTemplate from "./prompts/compact-request.md" with { type: "text" };
import editStoryFileDescription from "./prompts/tool-edit-story-file.md" with { type: "text" };
import listStoryFilesDescription from "./prompts/tool-list-story-files.md" with { type: "text" };
import readStoryFileDescription from "./prompts/tool-read-story-file.md" with { type: "text" };
import readStorySkillDescription from "./prompts/tool-read-story-skill.md" with { type: "text" };
import requestUserInputDescription from "./prompts/tool-request-user-input.md" with { type: "text" };
import submitStoryResultDescription from "./prompts/tool-submit-story-result.md" with { type: "text" };
import writeStoryFileDescription from "./prompts/tool-write-story-file.md" with { type: "text" };
import {
	createStoryFileWorkspace,
	mergeStoryFileArtifacts,
	normalizeStoryFilePath,
	type StoryFileRecord,
	type StoryFileWorkspace,
} from "./story-file-workspace";

const packageRoot = path.resolve(import.meta.dir, "..");
const skillsRoot = path.join(packageRoot, "skills");
const MAX_SKILL_FILE_CHARS = 200_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

const questionOptionSchema = z.object({
	label: z.string().min(1).max(100),
	value: z.string().min(1).max(200).optional(),
	description: z.string().max(300).optional(),
});

const questionSchema = z.object({
	id: z.string().min(1).max(80),
	header: z.string().max(80).optional(),
	question: z.string().min(1).max(1_000),
	options: z.array(questionOptionSchema).min(2).max(6),
});

const requestUserInputSchema = z.object({
	questions: z.array(questionSchema).min(1).max(3),
});

const editProposalSchema = z.object({
	revised_text: z.string().min(1),
	summary: z.string().max(2_000).optional(),
	blocks: z
		.array(
			z.object({
				original: z.string(),
				replacement: z.string(),
				reason: z.string().max(1_000),
			}),
		)
		.max(500)
		.optional(),
});

const findingSchema = z.object({
	severity: z.string().max(20).optional(),
	category: z.string().max(80).optional(),
	location: z.string().max(300).optional(),
	evidence: z.string().max(2_000).optional(),
	issue: z.string().max(2_000),
	fix: z.string().max(2_000).optional(),
});

const checkSchema = z.union([
	z.string().max(1_000),
	z.object({
		severity: z.string().max(20).optional(),
		issue: z.string().max(1_000),
	}),
]);

const submitStoryResultSchema = z.object({
	status: z.enum(["completed", "needs_input", "failed"]).default("completed"),
	selected_skill: z.string().max(120).optional(),
	skill_version: z.string().max(40).optional(),
	phase: z.string().max(80).optional(),
	output: z.string().optional(),
	summary: z.string().optional(),
	message: z.string().optional(),
	edit_proposal: editProposalSchema.optional(),
	artifacts: z.unknown().optional(),
	requirements: z.record(z.string(), z.unknown()).optional(),
	proposal: z.unknown().optional(),
	missing: z.array(z.string().max(120)).max(50).optional(),
	candidates: z.array(z.unknown()).max(100).optional(),
	references_loaded: z.array(z.string().max(500)).max(100).optional(),
	references_truncated: z.boolean().optional(),
	checks: z.array(checkSchema).max(100).optional(),
	findings: z.array(findingSchema).max(200).optional(),
	verdict: z.string().max(80).optional(),
	score: z.number().min(0).max(100).optional(),
	requested_mode: z.string().max(80).optional(),
	effective_mode: z.string().max(80).optional(),
	fallback: z.string().max(200).optional(),
	rubric: z.string().max(120).optional(),
	rubric_source: z.string().max(120).optional(),
	severity_counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

const readStorySkillSchema = z.object({
	path: z.string().min(1).max(500),
});

const listStoryFilesSchema = z.object({
	prefix: z.string().max(240).optional(),
});

const readStoryFileSchema = z.object({
	path: z.string().min(1).max(240),
});

const writeStoryFileSchema = z.object({
	path: z.string().min(1).max(240),
	title: z.string().min(1).max(160).optional(),
	category: z.string().min(1).max(40).optional(),
	content: z.string().min(1).max(50_000),
});

const editStoryFileSchema = z.object({
	path: z.string().min(1).max(240),
	old_text: z.string().min(1).max(50_000),
	new_text: z.string().max(50_000),
	replace_all: z.boolean().optional(),
});

type AgentMode = "story" | "delegate" | "compact";

export interface YemuModelConfig {
	provider?: "openai" | "anthropic";
	api_base_url?: string;
	api_key?: string;
	model?: string;
	reasoning_effort?: Effort;
	temperature?: number;
	max_tokens?: number;
	context_window?: number;
	allow_server_fallback?: boolean;
}

export interface StoryAgentInput {
	message: string;
	skill?: string | null;
	payload?: Record<string, unknown>;
	model_config?: YemuModelConfig | null;
}

export interface StoryAgentUsage {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
	estimated: boolean;
}

export interface StoryQuestion {
	requestId: string;
	questions: Array<{
		id: string;
		header?: string;
		question: string;
		options: Array<{
			label: string;
			value: string;
			description?: string;
		}>;
		isOther: boolean;
	}>;
}

export interface StoryAgentResult {
	status?: "completed" | "needs_input" | "failed";
	selected_skill?: string;
	skill_version?: string;
	phase?: string;
	output?: string;
	summary?: string;
	message?: string;
	edit_proposal?: z.infer<typeof editProposalSchema>;
	artifacts?: unknown;
	requirements?: Record<string, unknown>;
	proposal?: unknown;
	missing?: string[];
	candidates?: unknown[];
	references_loaded?: string[];
	references_truncated?: boolean;
	checks?: z.infer<typeof checkSchema>[];
	findings?: z.infer<typeof findingSchema>[];
	verdict?: string;
	score?: number;
	requested_mode?: string;
	effective_mode?: string;
	fallback?: string;
	rubric?: string;
	rubric_source?: string;
	severity_counts?: Record<string, number>;
	question?: StoryQuestion;
	usage?: StoryAgentUsage;
}

export interface StoryAgentResponse {
	run_id: string;
	status: "completed" | "needs_input" | "needs_model" | "failed";
	selected_skill: string;
	route: string;
	result: StoryAgentResult;
}

export interface StoryAgentCallbacks {
	onDelta?: (delta: string) => void | Promise<void>;
	onReasoningDelta?: (delta: string) => void | Promise<void>;
	onToolEvent?: (event: StoryToolEvent) => void | Promise<void>;
	readStoryFile?: (path: string) => Promise<StoryFileRecord | null>;
	writeStoryFile?: (file: StoryFileRecord) => void | Promise<void>;
	signal?: AbortSignal;
}

export interface StoryToolEvent {
	phase: "start" | "update" | "end";
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
	details?: Record<string, unknown>;
	isError?: boolean;
}

interface RuntimeRequest {
	mode: AgentMode;
	message: string;
	skillName: string;
	payload: Record<string, unknown>;
	modelConfig?: YemuModelConfig | null;
	role?: string;
	callbacks?: StoryAgentCallbacks;
}

interface RuntimeResult {
	submission: StoryAgentResult;
	selectedSkill: string;
	usage: StoryAgentUsage;
}

interface ToolState {
	activeSkill: string;
	question?: StoryQuestion;
	submission?: StoryAgentResult;
	referencesLoaded: Set<string>;
	storyFiles: StoryFileWorkspace;
	canMutateStoryFiles: boolean;
	persistStoryFile?: (file: StoryFileRecord) => void | Promise<void>;
}

interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

export const STORY_AGENT_RUNTIME_INFO = Object.freeze({
	id: "yemu-agent-runtime",
	protocolVersion: 1,
	execution: "in-process",
});

let skillCache: Promise<Map<string, Skill>> | undefined;

function frontmatterValue(source: string, key: string): string {
	const frontmatter = source.startsWith("---\n") ? source.slice(4, source.indexOf("\n---", 4)) : "";
	const match = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
	const value = match?.[1]?.trim() ?? "";
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

async function discoverSkills(): Promise<Map<string, Skill>> {
	const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
	const skills = await Promise.all(
		entries
			.filter(entry => entry.isDirectory())
			.map(async entry => {
				const filePath = path.join(skillsRoot, entry.name, "SKILL.md");
				try {
					const source = await fs.readFile(filePath, "utf8");
					const name = frontmatterValue(source, "name") || entry.name;
					return {
						name,
						description: frontmatterValue(source, "description"),
						filePath,
						baseDir: path.dirname(filePath),
					};
				} catch {
					return undefined;
				}
			}),
	);
	return new Map(skills.filter((skill): skill is Skill => skill !== undefined).map(skill => [skill.name, skill]));
}

function loadSkillMap(): Promise<Map<string, Skill>> {
	if (!skillCache) {
		skillCache = discoverSkills();
	}
	return skillCache;
}

function routeStorySkill(message: string): string {
	const text = message.toLowerCase();
	if (/去\s*ai|去味|自然化|润色/.test(text)) return "story-deslop";
	if (/审稿|审查|诊断|review/.test(text)) return "story-review";
	if (/导入|反向解析/.test(text)) return "story-import";
	if (/短篇/.test(text) && /拆|分析/.test(text)) return "story-short-analyze";
	if (/长篇/.test(text) && /拆|分析/.test(text)) return "story-long-analyze";
	if (/短篇/.test(text) && /榜|选题|趋势/.test(text)) return "story-short-scan";
	if (/榜|选题|趋势|市场/.test(text)) return "story-long-scan";
	if (/短篇/.test(text) && /写|续|大纲|开书/.test(text)) return "story-short-write";
	if (/写|续写|日更|大纲|开书|章节|正文/.test(text)) return "story-long-write";
	if (/搜索|检索|查资料|联网/.test(text)) return "story-search";
	return "story";
}

function cleanBaseUrl(value: string | undefined, fallback: string): string {
	const candidate = value?.trim() || fallback;
	return candidate.replace(/\/+$/, "");
}

function openAICompatibleProvider(baseUrl: string): string {
	try {
		const hostname = new URL(baseUrl).hostname.toLowerCase();
		if (hostname === "api.openai.com") return "openai";
		if (hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com")) return "deepseek";
	} catch {
		// Invalid URLs are rejected by the settings API before reaching the runtime.
	}
	return "openai-compatible";
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
	return Number.isFinite(value) && Number(value) > 0 ? Math.min(Math.floor(Number(value)), maximum) : fallback;
}

function modelForConfig(config: YemuModelConfig | null | undefined): { model: Model; apiKey: string; effort?: Effort } {
	const configuredProvider = config?.provider === "anthropic" ? "anthropic" : "openai";
	const apiKey =
		config?.api_key?.trim() ||
		(configuredProvider === "anthropic" ? Bun.env.ANTHROPIC_API_KEY?.trim() : Bun.env.OPENAI_API_KEY?.trim()) ||
		"";
	if (!apiKey) {
		throw Object.assign(new Error("模型 API Key 未配置，请先在设置中填写密钥"), { status: 400 });
	}

	const id =
		config?.model?.trim() ||
		(configuredProvider === "anthropic" ? Bun.env.ANTHROPIC_MODEL?.trim() : Bun.env.OPENAI_MODEL?.trim()) ||
		(configuredProvider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4o-mini");
	const api = configuredProvider === "anthropic" ? "anthropic-messages" : "openai-completions";
	const baseUrl =
		configuredProvider === "anthropic"
			? cleanBaseUrl(config?.api_base_url || Bun.env.ANTHROPIC_BASE_URL, "https://api.anthropic.com")
			: cleanBaseUrl(config?.api_base_url || Bun.env.OPENAI_BASE_URL, "https://api.openai.com/v1");
	const provider = configuredProvider === "anthropic" ? "anthropic" : openAICompatibleProvider(baseUrl);
	const effort = config?.reasoning_effort;
	const model = buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl,
		reasoning: effort !== undefined && effort !== "minimal",
		input: ["text"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: positiveInteger(config?.context_window, DEFAULT_CONTEXT_WINDOW, 2_000_000),
		maxTokens: positiveInteger(config?.max_tokens, DEFAULT_MAX_TOKENS, 128_000),
	});
	return { model, apiKey, effort };
}

function safePayloadJson(payload: Record<string, unknown>): string {
	return JSON.stringify(payload, null, 2)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026");
}

async function skillInstructions(
	skillName: string,
	skillMap: Map<string, Skill>,
	payload: Record<string, unknown>,
): Promise<string> {
	const community = payload.community_skill;
	if (skillName === "story-community" && community && typeof community === "object" && !Array.isArray(community)) {
		const instructions = (community as Record<string, unknown>).instructions;
		if (typeof instructions === "string" && instructions.trim()) return instructions;
	}
	const skill = skillMap.get(skillName) ?? skillMap.get("story");
	if (!skill) throw new Error("Story Skill 目录为空");
	return await Bun.file(skill.filePath).text();
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveSkillFile(
	requestPath: string,
	skillMap: Map<string, Skill>,
): Promise<{ skillName: string; filePath: string }> {
	const normalized = requestPath.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
	const segments = normalized.split("/").filter(Boolean);
	if (!segments.length || segments.some(segment => segment === "." || segment === "..")) {
		throw new Error("Skill 路径无效");
	}
	const skillName = segments.shift() ?? "";
	const skill = skillMap.get(skillName);
	if (!skill) throw new Error(`未知 Story Skill：${skillName}`);
	const requested = segments.length ? path.resolve(skill.baseDir, ...segments) : skill.filePath;
	const [realBase, realRequested] = await Promise.all([fs.realpath(skill.baseDir), fs.realpath(requested)]);
	if (!isPathInside(realBase, realRequested)) throw new Error("Skill 路径越界");
	const stat = await fs.stat(realRequested);
	if (!stat.isFile()) throw new Error("Skill 路径不是文件");
	return { skillName, filePath: realRequested };
}

function createTools(state: ToolState, skillMap: Map<string, Skill>): AgentTool[] {
	const readTool: AgentTool<typeof readStorySkillSchema, { path: string }> = {
		name: "read_story_skill",
		label: "读取 Story Skill",
		description: readStorySkillDescription.trim(),
		parameters: readStorySkillSchema,
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId, params) {
			const resolved = await resolveSkillFile(params.path, skillMap);
			const content = await Bun.file(resolved.filePath).text();
			if (content.length > MAX_SKILL_FILE_CHARS) throw new Error("Skill 文件过长，拒绝加载");
			state.activeSkill = resolved.skillName;
			state.referencesLoaded.add(
				`${resolved.skillName}/${path.relative(path.join(skillsRoot, resolved.skillName), resolved.filePath)}`,
			);
			return {
				content: [{ type: "text", text: content }],
				details: { path: resolved.filePath },
			};
		},
	};

	const inputTool: AgentTool<typeof requestUserInputSchema, { requestId: string }> = {
		name: "request_user_input",
		label: "请求用户输入",
		description: requestUserInputDescription.trim(),
		parameters: requestUserInputSchema,
		loadMode: "essential",
		approval: "read",
		async execute(toolCallId, params) {
			state.question = {
				requestId: toolCallId,
				questions: params.questions.map(question => ({
					id: question.id,
					header: question.header,
					question: question.question,
					options: question.options.map(option => ({
						label: option.label,
						value: option.value ?? option.label,
						description: option.description,
					})),
					isOther: true,
				})),
			};
			return {
				content: [{ type: "text", text: "问题已交给用户。请结束本次执行，等待用户回答。" }],
				details: { requestId: toolCallId },
			};
		},
	};

	const listFilesTool: AgentTool<typeof listStoryFilesSchema, { count: number }> = {
		name: "list_story_files",
		label: "列出作品文件",
		description: listStoryFilesDescription.trim(),
		parameters: listStoryFilesSchema,
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId, params) {
			const files = state.storyFiles.list(params.prefix);
			return {
				content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }],
				details: { count: files.length },
			};
		},
	};

	const readFileTool: AgentTool<typeof readStoryFileSchema, { path: string }> = {
		name: "read_story_file",
		label: "读取作品文件",
		description: readStoryFileDescription.trim(),
		parameters: readStoryFileSchema,
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId, params) {
			const file = await state.storyFiles.read(params.path);
			return {
				content: [{ type: "text", text: file.content ?? "" }],
				details: { path: file.path },
			};
		},
	};

	const writeFileTool: AgentTool<typeof writeStoryFileSchema, { path: string; chars: number }> = {
		name: "write_story_file",
		label: "暂存作品文件",
		description: writeStoryFileDescription.trim(),
		parameters: writeStoryFileSchema,
		loadMode: "essential",
		approval: "write",
		async execute(_toolCallId, params) {
			if (!state.canMutateStoryFiles) throw new Error("当前任务未授权修改作品文件");
			const path = normalizeStoryFilePath(params.path);
			const fallbackTitle = path.split("/").at(-1)?.replace(/\.[^.]+$/, "") || "作品文件";
			const pendingFile = {
				path,
				title: params.title || fallbackTitle,
				category: params.category || path.split("/")[0] || "资料",
				content: params.content,
			};
			await state.persistStoryFile?.(pendingFile);
			const file = state.storyFiles.write(pendingFile);
			return {
				content: [{ type: "text", text: `已暂存 ${file.path}（${file.content?.length ?? 0} 字符）。可以继续处理其他文件。` }],
				details: { path: file.path, chars: file.content?.length ?? 0 },
			};
		},
	};

	const editFileTool: AgentTool<typeof editStoryFileSchema, { path: string; chars: number }> = {
		name: "edit_story_file",
		label: "编辑作品文件",
		description: editStoryFileDescription.trim(),
		parameters: editStoryFileSchema,
		loadMode: "essential",
		approval: "write",
		async execute(_toolCallId, params) {
			if (!state.canMutateStoryFiles) throw new Error("当前任务未授权修改作品文件");
			if (!params.old_text) throw new Error("old_text 不能为空");
			const current = await state.storyFiles.read(params.path);
			const content = current.content ?? "";
			const occurrences = content.split(params.old_text).length - 1;
			if (!occurrences) throw new Error("作品文件中没有找到 old_text");
			if (!params.replace_all && occurrences > 1) {
				throw new Error("old_text 出现多次；请提供更精确的文本或启用 replace_all");
			}
			const updated = params.replace_all
				? content.replaceAll(params.old_text, params.new_text)
				: content.replace(params.old_text, params.new_text);
			const pendingFile = { ...current, content: updated };
			await state.persistStoryFile?.(pendingFile);
			const file = state.storyFiles.write(pendingFile);
			return {
				content: [{ type: "text", text: `已暂存对 ${file.path} 的修改（${file.content?.length ?? 0} 字符）。可以继续处理其他文件。` }],
				details: { path: file.path, chars: file.content?.length ?? 0 },
			};
		},
	};

	const submitTool: AgentTool<typeof submitStoryResultSchema, { accepted: boolean }> = {
		name: "submit_story_result",
		label: "提交 Story 结果",
		description: submitStoryResultDescription.trim(),
		parameters: submitStoryResultSchema,
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId, params) {
			state.submission = { ...params };
			return {
				content: [{ type: "text", text: "Story 结果已提交。" }],
				details: { accepted: true },
			};
		},
	};

	return [
		readTool,
		listFilesTool,
		readFileTool,
		...(state.canMutateStoryFiles ? [writeFileTool, editFileTool] : []),
		inputTool,
		submitTool,
	];
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return (value as Record<string, unknown>).role === "assistant";
}

function assistantText(messages: readonly unknown[]): string {
	return messages
		.filter(isAssistantMessage)
		.flatMap(message => message.content.flatMap(content => (content.type === "text" ? [content.text] : [])))
		.join("\n")
		.trim();
}

function aggregateUsage(messages: readonly unknown[]): StoryAgentUsage {
	const usage = messages.filter(isAssistantMessage).reduce(
		(total, message) => {
			total.input += message.usage.input;
			total.cached += message.usage.cacheRead;
			total.output += message.usage.output;
			total.reasoning += message.usage.reasoningTokens ?? 0;
			total.all += message.usage.totalTokens;
			return total;
		},
		{ input: 0, cached: 0, output: 0, reasoning: 0, all: 0 },
	);
	return {
		input_tokens: usage.input,
		cached_input_tokens: usage.cached,
		output_tokens: usage.output,
		reasoning_output_tokens: usage.reasoning,
		total_tokens: usage.all || usage.input + usage.cached + usage.output,
		estimated: false,
	};
}

function enqueueCallback<T>(
	previous: Promise<void>,
	callback: ((value: T) => void | Promise<void>) | undefined,
	value: T,
): Promise<void> {
	if (!callback) return previous;
	return previous.then(async () => {
		await callback(value);
	});
}

function storyFileMutationRequirement(message: string, payload: Record<string, unknown>): number {
	const explicit = Number(payload.required_story_files ?? payload.requiredStoryFiles);
	if (Number.isFinite(explicit) && explicit > 0) return Math.min(12, Math.floor(explicit));
	const currentText = String(message || "").trim();
	const isFileMutation = (value: string): boolean =>
		/(?:文件|文档|档案|资料|\.md\b|\.txt\b|\.json\b)/i.test(value) &&
		/(?:创建|新建|建立|生成|写入|保存|落盘|补全|更新|修改|编辑|重写|整理成)/.test(value);
	let sourceText = isFileMutation(currentText) ? currentText : "";
	if (!sourceText && /^(?:确认|好的|好|可以|开始|执行|继续|就这样|没问题|按.+做|采用.+方案)[。！!\s]*$/.test(currentText)) {
		const conversation = Array.isArray(payload.conversation) ? payload.conversation : [];
		for (let index = conversation.length - 1; index >= Math.max(0, conversation.length - 12); index -= 1) {
			const entry = conversation[index];
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const record = entry as Record<string, unknown>;
			const candidate = record.role === "user" ? String(record.text ?? record.content ?? "").trim() : "";
			if (isFileMutation(candidate)) {
				sourceText = candidate;
				break;
			}
		}
	}
	if (!sourceText) return 0;
	const countMatch = /([一二两三四五六七八九十\d]+)\s*(?:份|个|套|组)/.exec(sourceText);
	if (!countMatch) return 1;
	if (/^\d+$/.test(countMatch[1])) return Math.min(12, Math.max(1, Number(countMatch[1])));
	const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
	if (countMatch[1] === "十") return 10;
	if (countMatch[1].includes("十")) {
		const [tens, ones] = countMatch[1].split("十");
		return Math.min(12, Math.max(1, (digits[tens] || 1) * 10 + (digits[ones] || 0)));
	}
	return digits[countMatch[1]] || 1;
}

function compactToolArguments(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const args = value as Record<string, unknown>;
	const compact: Record<string, unknown> = {};
	for (const key of ["path", "prefix", "title", "category", "replace_all", "requestId", "count", "chars", "accepted"]) {
		if (args[key] !== undefined) compact[key] = args[key];
	}
	for (const key of ["content", "old_text", "new_text"]) {
		if (typeof args[key] === "string") compact[`${key}_chars`] = args[key].length;
	}
	if (Array.isArray(args.questions)) compact.questions = args.questions.length;
	return compact;
}

function compactToolDetails(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result = value as Record<string, unknown>;
	const details = result.details;
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	return compactToolArguments(details);
}

async function runRuntime(request: RuntimeRequest): Promise<RuntimeResult> {
	const skillMap = await loadSkillMap();
	const instructions =
		request.mode === "compact" ? "" : await skillInstructions(request.skillName, skillMap, request.payload);
	const systemPrompt = render(agentSystemTemplate, {
		mode: request.mode,
		role: request.role,
	});
	const userPrompt =
		request.mode === "compact"
			? render(compactRequestTemplate, {
					existingSummary: String(request.payload.existingSummary ?? ""),
					messagesJson: safePayloadJson({ messages: request.payload.messages }),
				})
			: render(agentRequestTemplate, {
					skillName: request.skillName,
					skillInstructions: instructions,
					message: request.message,
					payloadJson: safePayloadJson(request.payload),
				});
	const { model, apiKey, effort } = modelForConfig(request.modelConfig);
	const temperature =
		Number.isFinite(request.modelConfig?.temperature) && Number(request.modelConfig?.temperature) >= 0
			? Number(request.modelConfig?.temperature)
			: undefined;
	const toolState: ToolState = {
		activeSkill: request.skillName,
		referencesLoaded: new Set<string>(),
		storyFiles: createStoryFileWorkspace(request.payload, request.callbacks?.readStoryFile),
		canMutateStoryFiles:
			request.mode === "story" &&
			["allow", "propose"].includes(
				String((request.payload.tool_policy as Record<string, unknown> | undefined)?.mutateStoryData ?? "deny"),
			),
		persistStoryFile:
			String((request.payload.tool_policy as Record<string, unknown> | undefined)?.mutateStoryData ?? "deny") ===
			"allow"
				? request.callbacks?.writeStoryFile
				: undefined,
	};
	const requiredStoryFiles = toolState.canMutateStoryFiles
		? storyFileMutationRequirement(request.message, request.payload)
		: 0;
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: [systemPrompt],
			thinkingLevel: effort,
			tools: createTools(toolState, skillMap),
			messages: [],
		},
		getApiKey: () => apiKey,
		temperature,
		deadline: request.callbacks?.signal ? undefined : Date.now() + 300_000,
	});
	let callbackQueue = Promise.resolve();
	const unsubscribe = agent.subscribe((event: AgentEvent) => {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta") {
				callbackQueue = enqueueCallback(callbackQueue, request.callbacks?.onDelta, update.delta);
			}
			if (update.type === "thinking_delta") {
				callbackQueue = enqueueCallback(callbackQueue, request.callbacks?.onReasoningDelta, update.delta);
			}
			return;
		}
		if (event.type === "tool_execution_start") {
			callbackQueue = enqueueCallback(callbackQueue, request.callbacks?.onToolEvent, {
				phase: "start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				arguments: compactToolArguments(event.args),
			});
		}
		if (event.type === "tool_execution_update") {
			callbackQueue = enqueueCallback(callbackQueue, request.callbacks?.onToolEvent, {
				phase: "update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				arguments: compactToolArguments(event.args),
			});
		}
		if (event.type === "tool_execution_end") {
			callbackQueue = enqueueCallback(callbackQueue, request.callbacks?.onToolEvent, {
				phase: "end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				arguments: {},
				details: compactToolDetails(event.result),
				isError: event.isError === true,
			});
		}
	});
	const abort = (): void => {
		agent.abort(request.callbacks?.signal?.reason);
	};
	request.callbacks?.signal?.addEventListener("abort", abort, { once: true });

	try {
		if (request.callbacks?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		await agent.prompt(
			userPrompt,
			requiredStoryFiles ? { toolChoice: { type: "function", name: "list_story_files" } } : undefined,
		);
		let validationAttempts = 0;
		while (
			requiredStoryFiles > toolState.storyFiles.written().length &&
			!toolState.question &&
			validationAttempts < requiredStoryFiles
		) {
			const before = toolState.storyFiles.written().length;
			const remaining = requiredStoryFiles - before;
			toolState.submission = undefined;
			await agent.prompt(
				`系统执行校验：用户要求实际创建或修改作品文件，但目前只成功写入 ${before} 份，至少还需 ${remaining} 份。现在必须调用 write_story_file 写入一份尚未完成的文件；不要只描述计划，也不要在达到数量前提交结果。`,
				{ toolChoice: { type: "function", name: "write_story_file" } },
			);
			validationAttempts += 1;
			if (toolState.storyFiles.written().length <= before) break;
		}
		await callbackQueue;
		if (agent.state.error) {
			throw new Error(agent.state.error);
		}
		const messages = agent.state.messages;
		const fallbackText = assistantText(messages);
		const submission: StoryAgentResult = toolState.submission
			? { ...toolState.submission }
			: { status: "completed", output: fallbackText };
		if (toolState.question) {
			submission.status = "needs_input";
			submission.question = toolState.question;
		}
		const mergedArtifacts = mergeStoryFileArtifacts(submission.artifacts, toolState.storyFiles.written());
		if (mergedArtifacts) submission.artifacts = mergedArtifacts;
		const references = new Set([...(submission.references_loaded ?? []), ...toolState.referencesLoaded]);
		if (references.size) submission.references_loaded = [...references];
		if (
			!submission.output &&
			!submission.summary &&
			!submission.message &&
			!submission.edit_proposal &&
			fallbackText
		) {
			submission.output = fallbackText;
		}
		return {
			submission,
			selectedSkill: submission.selected_skill || toolState.activeSkill,
			usage: aggregateUsage(messages),
		};
	} finally {
		request.callbacks?.signal?.removeEventListener("abort", abort);
		unsubscribe();
		agent.abort();
	}
}

export async function runStoryAgent(
	input: StoryAgentInput,
	callbacks: StoryAgentCallbacks = {},
): Promise<StoryAgentResponse> {
	const skillMap = await loadSkillMap();
	const requested = input.skill?.trim();
	const selectedSkill = requested && skillMap.has(requested) ? requested : routeStorySkill(input.message);
	const route = requested
		? skillMap.has(requested)
			? "explicit"
			: "explicit-unavailable -> story-router"
		: "story-router";
	const result = await runRuntime({
		mode: "story",
		message: input.message,
		skillName: selectedSkill,
		payload: input.payload ?? {},
		modelConfig: input.model_config,
		callbacks,
	});
	const status = result.submission.status ?? "completed";
	result.submission.usage = result.usage;
	return {
		run_id: crypto.randomUUID(),
		status,
		selected_skill: result.selectedSkill,
		route,
		result: result.submission,
	};
}

export async function runStoryDelegate(
	input: StoryAgentInput & { role: string },
	callbacks: StoryAgentCallbacks = {},
): Promise<{ status: "completed" | "failed"; summary: string; usage: StoryAgentUsage; error?: string }> {
	try {
		const selectedSkill = input.skill?.trim() || routeStorySkill(input.message);
		const result = await runRuntime({
			mode: "delegate",
			message: input.message,
			skillName: selectedSkill,
			payload: input.payload ?? {},
			modelConfig: input.model_config,
			role: input.role,
			callbacks,
		});
		return {
			status: result.submission.status === "failed" ? "failed" : "completed",
			summary:
				result.submission.summary || result.submission.output || result.submission.message || "子代理未返回摘要",
			usage: result.usage,
		};
	} catch (error) {
		return {
			status: "failed",
			summary: "",
			usage: {
				input_tokens: 0,
				cached_input_tokens: 0,
				output_tokens: 0,
				reasoning_output_tokens: 0,
				total_tokens: 0,
				estimated: false,
			},
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runContextCompaction(
	modelConfig: YemuModelConfig | null | undefined,
	input: { existingSummary?: string; messages?: unknown[] },
	callbacks: StoryAgentCallbacks = {},
): Promise<{ status: "completed"; summary: string }> {
	const result = await runRuntime({
		mode: "compact",
		message: "压缩创作会话",
		skillName: "story",
		payload: {
			existingSummary: input.existingSummary ?? "",
			messages: input.messages ?? [],
		},
		modelConfig,
		callbacks,
	});
	const summary = result.submission.summary || result.submission.output || result.submission.message || "";
	if (!summary.trim()) throw new Error("上下文压缩没有返回摘要");
	return { status: "completed", summary: summary.trim() };
}

export async function listStorySkills(): Promise<
	Array<{ name: string; description: string; status: "ready"; executor: "yemu-agent-runtime" }>
> {
	const skillMap = await loadSkillMap();
	return [...skillMap.values()].map(skill => ({
		name: skill.name,
		description: skill.description,
		status: "ready",
		executor: "yemu-agent-runtime",
	}));
}
