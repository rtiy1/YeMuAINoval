import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent, type AgentPromptOptions } from "@yemu/agent-core/agent";
import { estimateTokens } from "@yemu/agent-core/compaction";
import type { AgentEvent, AgentMessage, AgentTool } from "@yemu/agent-core/types";
import { buildModel } from "@yemu/model-catalog/build";
import { type AssistantMessage, type Effort, type Model, z } from "@yemu/model-runtime";
import * as AIError from "@yemu/model-runtime/error";
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
	runSearchQuery,
	webSearchSchema,
	type SearchQueryParams,
} from "../packages/coding-agent/src/web/search/index";
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
const DEFAULT_THINKING_BUDGETS = {
	minimal: 1_024,
	low: 2_048,
	medium: 8_192,
	high: 16_384,
	xhigh: 32_768,
	max: 32_768,
} satisfies Record<Effort, number>;

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

const storyFileContentSchema = z.union([
	z.string().min(1).max(50_000),
	z.array(z.unknown()).max(200),
	z.record(z.string(), z.unknown()),
]).describe("Markdown 文本；也接受可自动转换为 Markdown 的结构化内容");

const writeStoryFileSchema = z.object({
	path: z.string().min(1).max(240),
	title: z.string().min(1).max(160).optional(),
	category: z.string().min(1).max(40).optional(),
	content: storyFileContentSchema,
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
	thinking_budgets?: Partial<Record<Effort, number>>;
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
	searchWeb?: (params: SearchQueryParams, signal?: AbortSignal) => Promise<StoryWebSearchResult>;
	signal?: AbortSignal;
}

export interface StoryWebSearchResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		response?: unknown;
		error?: string;
	};
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
	canSearchWeb: boolean;
	searchWeb?: (params: SearchQueryParams, signal?: AbortSignal) => Promise<StoryWebSearchResult>;
}

function structuredStoryFileText(value: unknown, depth = 0): string {
	if (depth > 8 || value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) {
		return value.map(item => structuredStoryFileText(item, depth + 1)).filter(Boolean).join("\n\n");
	}
	if (typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	const heading = ["title", "heading", "name", "label"]
		.map(key => structuredStoryFileText(record[key], depth + 1).trim())
		.find(Boolean);
	const bodyKey = ["markdown", "content", "body", "text"].find(key => record[key] !== undefined);
	if (bodyKey) {
		const body = structuredStoryFileText(record[bodyKey], depth + 1).trim();
		return [heading ? `${depth <= 1 ? "#" : "##"} ${heading}` : "", body].filter(Boolean).join("\n\n");
	}
	const ignored = new Set(["title", "heading", "name", "label", "type"]);
	const unwrappedCollections = new Set(["sections", "items", "entries", "blocks", "list"]);
	const sections = Object.entries(record).flatMap(([key, entry]) => {
		if (ignored.has(key)) return [];
		const body = structuredStoryFileText(entry, depth + 1).trim();
		if (!body) return [];
		if (unwrappedCollections.has(key)) return [body];
		const label = key.replace(/[_-]+/g, " ").trim();
		return [`${depth <= 1 ? "##" : "###"} ${label}\n\n${body}`];
	});
	return [heading ? `${depth === 0 ? "#" : "##"} ${heading}` : "", ...sections].filter(Boolean).join("\n\n");
}

function normalizeStoryFileContent(value: unknown): string {
	const content = structuredStoryFileText(value).replace(/\r\n?/g, "\n").trim();
	if (!content) throw new Error("作品文件 content 不能为空");
	if (content.length > 50_000) throw new Error("作品文件 content 不能超过 50000 字符");
	return content;
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

type PromptPackingLevel = "normal" | "compact" | "minimal";

function headTailExcerpt(value: unknown, maxChars: number): unknown {
	if (typeof value !== "string" || value.length <= maxChars) return value;
	const headChars = Math.max(1, Math.floor(maxChars * 0.3));
	const tailChars = Math.max(1, maxChars - headChars);
	return `${value.slice(0, headChars)}\n…（上下文压缩省略 ${value.length - maxChars} 字符）…\n${value.slice(-tailChars)}`;
}

function packedRecordList(
	value: unknown,
	limit: number,
	contentChars: number,
	keep: "first" | "last" = "last",
): Array<Record<string, unknown>> | unknown {
	if (!Array.isArray(value)) return value;
	const entries = keep === "first" ? value.slice(0, limit) : value.slice(-limit);
	return entries.flatMap(entry => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const record = structuredClone(entry as Record<string, unknown>);
		for (const key of ["content", "text", "body", "ending", "outline", "summary"]) {
			record[key] = headTailExcerpt(record[key], contentChars);
		}
		return [record];
	});
}

function packWritingContext(value: unknown, level: Exclude<PromptPackingLevel, "normal">): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const context = structuredClone(value as Record<string, unknown>);
	const minimal = level === "minimal";
	context.previousChapters = packedRecordList(context.previousChapters, minimal ? 2 : 4, minimal ? 900 : 1_600);
	context.storyMemory = packedRecordList(context.storyMemory, minimal ? 10 : 24, minimal ? 500 : 800, "first");
	context.materials = packedRecordList(context.materials, minimal ? 5 : 10, minimal ? 500 : 800, "first");
	context.unresolvedForeshadows = packedRecordList(
		context.unresolvedForeshadows,
		minimal ? 8 : 16,
		minimal ? 500 : 800,
		"first",
	);
	if (context.storyFiles && typeof context.storyFiles === "object" && !Array.isArray(context.storyFiles)) {
		const storyFiles = structuredClone(context.storyFiles as Record<string, unknown>);
		storyFiles.inventory = Array.isArray(storyFiles.inventory)
			? storyFiles.inventory.slice(0, minimal ? 30 : 60)
			: storyFiles.inventory;
		storyFiles.loaded = packedRecordList(
			storyFiles.loaded,
			minimal ? 2 : 5,
			minimal ? 3_000 : 6_000,
			"first",
		);
		context.storyFiles = storyFiles;
	}
	if (context.layers && typeof context.layers === "object" && !Array.isArray(context.layers)) {
		const layers = structuredClone(context.layers as Record<string, unknown>);
		for (const [name, limit] of [["near", minimal ? 2 : 3], ["mid", minimal ? 3 : 7], ["far", minimal ? 6 : 15]] as const) {
			const layer = layers[name];
			if (!layer || typeof layer !== "object" || Array.isArray(layer)) continue;
			const packedLayer = structuredClone(layer as Record<string, unknown>);
			packedLayer.chapters = packedRecordList(packedLayer.chapters, limit, minimal ? 600 : 900);
			layers[name] = packedLayer;
		}
		context.layers = layers;
	}
	return context;
}

function packPromptPayload(payload: Record<string, unknown>, level: PromptPackingLevel): Record<string, unknown> {
	const packed = structuredClone(payload);
	if (typeof packed.content === "string") {
		if (packed.content === packed.source_text || packed.content === packed.selected_text) delete packed.content;
	}
	if (level === "normal") return packed;
	const minimal = level === "minimal";
	packed.source_text = headTailExcerpt(packed.source_text, minimal ? 12_000 : 30_000);
	packed.selected_text = headTailExcerpt(packed.selected_text, minimal ? 10_000 : 24_000);
	packed.content = headTailExcerpt(packed.content, minimal ? 10_000 : 24_000);
	packed.conversation_summary = headTailExcerpt(packed.conversation_summary, minimal ? 8_000 : 16_000);
	packed.conversation = packedRecordList(packed.conversation, minimal ? 4 : 8, minimal ? 2_000 : 4_000);
	packed.continuation_conversation = packedRecordList(
		packed.continuation_conversation,
		minimal ? 2 : 4,
		minimal ? 2_000 : 4_000,
	);
	packed.attached_files = packedRecordList(
		packed.attached_files,
		minimal ? 2 : 4,
		minimal ? 4_000 : 8_000,
		"first",
	);
	packed.writing_context = packWritingContext(packed.writing_context, level);
	return packed;
}

function promptTokenEstimate(systemPrompt: string, userPrompt: string): number {
	const messages: AgentMessage[] = [systemPrompt, userPrompt].map(text => ({
		role: "user",
		content: [{ type: "text", text }],
		timestamp: 0,
	}));
	return messages.reduce((total, message) => total + estimateTokens(message), 0);
}

function compactRecoveryMessages(messages: readonly AgentMessage[], reducedUserPrompt: string): AgentMessage[] {
	let firstUserReplaced = false;
	return messages.map(message => {
		if (message.role === "user" && !firstUserReplaced) {
			firstUserReplaced = true;
			return {
				...message,
				content: typeof message.content === "string"
					? reducedUserPrompt
					: message.content.map(block => block.type === "text" ? { ...block, text: reducedUserPrompt } : block),
			};
		}
		if (message.role === "toolResult") {
			return {
				...message,
				content: message.content.map(block =>
					block.type === "text" ? { ...block, text: String(headTailExcerpt(block.text, 6_000)) } : block,
				),
			};
		}
		return message;
	});
}

function hasReplayUnsafeAssistantOutput(message: AssistantMessage): boolean {
	return message.content.some(block =>
		block.type === "toolCall" ||
		block.type === "image" ||
		block.type === "anthropicServerTool" ||
		(block.type === "text" && block.text.trim().length > 0),
	);
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(delayMs);
		return;
	}
	if (signal.aborted) throw new DOMException("Aborted", "AbortError");
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = (): void => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onAbort);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
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

	const searchTool: AgentTool<typeof webSearchSchema, StoryWebSearchResult["details"]> = {
		name: "web_search",
		label: "联网搜索",
		description:
			"搜索公开网页中的最新资料。返回标题、链接与摘要；需要当前信息或用户明确要求联网时调用，不得伪造搜索结果。",
		parameters: webSearchSchema,
		strict: true,
		loadMode: "essential",
		approval: "read",
		async execute(_toolCallId, params, signal) {
			if (!state.canSearchWeb) throw new Error("当前任务未开启联网搜索");
			const result = state.searchWeb
				? await state.searchWeb(params, signal)
				: await runSearchQuery(params, { signal });
			if (result.details.error) throw new Error(result.details.error);
			return result;
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
			const content = normalizeStoryFileContent(params.content);
			const pendingFile = {
				path,
				title: params.title || fallbackTitle,
				category: params.category || path.split("/")[0] || "资料",
				content,
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
		...(state.canSearchWeb ? [searchTool] : []),
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

function latestAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isAssistantMessage(message)) return message;
	}
	return undefined;
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
			const role = String(record.role ?? "");
			const candidate = ["user", "assistant"].includes(role)
				? String(record.text ?? record.content ?? "").trim()
				: "";
			const pendingAssistantFile =
				role === "assistant" && /(?:是否|要不要|确认后|待确认|确认创建|确认写入)/.test(candidate);
			if (isFileMutation(candidate) && (role === "user" || pendingAssistantFile)) {
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
	for (const key of [
		"path",
		"prefix",
		"title",
		"category",
		"replace_all",
		"requestId",
		"count",
		"chars",
		"accepted",
		"query",
		"recency",
		"limit",
		"provider",
		"error",
	]) {
		if (args[key] !== undefined) compact[key] = args[key];
	}
	if (args.response && typeof args.response === "object" && !Array.isArray(args.response)) {
		const response = args.response as Record<string, unknown>;
		compact.provider = response.provider;
		if (Array.isArray(response.sources)) compact.sources = response.sources.length;
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
		webSearchEnabled:
			request.mode === "story" &&
			(request.skillName === "story-search" ||
				String((request.payload.tool_policy as Record<string, unknown> | undefined)?.externalSearch ?? "deny") ===
					"allow"),
	});
	const { model, apiKey, effort } = modelForConfig(request.modelConfig);
	const renderUserPrompt = (payload: Record<string, unknown>): string =>
		request.mode === "compact"
			? render(compactRequestTemplate, {
					existingSummary: String(payload.existingSummary ?? ""),
					instructions: String(payload.instructions ?? ""),
					messagesJson: safePayloadJson({ messages: payload.messages }),
				})
			: render(agentRequestTemplate, {
					skillName: request.skillName,
					skillInstructions: instructions,
					message: request.message,
					payloadJson: safePayloadJson(payload),
				});
	let promptPayload = request.mode === "compact" ? request.payload : packPromptPayload(request.payload, "normal");
	let userPrompt = renderUserPrompt(promptPayload);
	const contextWindow = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
	const promptThreshold = Math.max(1, Math.floor(contextWindow * 0.85));
	if (request.mode !== "compact" && promptTokenEstimate(systemPrompt, userPrompt) > promptThreshold) {
		promptPayload = packPromptPayload(request.payload, "compact");
		userPrompt = renderUserPrompt(promptPayload);
	}
	if (request.mode !== "compact" && promptTokenEstimate(systemPrompt, userPrompt) > promptThreshold) {
		promptPayload = packPromptPayload(request.payload, "minimal");
		userPrompt = renderUserPrompt(promptPayload);
	}
	const overflowRecoveryPrompt = request.mode === "compact"
		? userPrompt
		: renderUserPrompt(packPromptPayload(request.payload, "minimal"));
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
		canSearchWeb:
			request.mode === "story" &&
			(request.skillName === "story-search" ||
				String((request.payload.tool_policy as Record<string, unknown> | undefined)?.externalSearch ?? "deny") ===
					"allow"),
		searchWeb: request.callbacks?.searchWeb,
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
		thinkingBudgets: { ...DEFAULT_THINKING_BUDGETS, ...(request.modelConfig?.thinking_budgets ?? {}) },
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
	let transientRetryCount = 0;
	let overflowRecoveryCount = 0;
	const promptWithRecovery = async (input: string, options?: AgentPromptOptions): Promise<void> => {
		await agent.prompt(input, options);
		while (agent.state.error) {
			request.callbacks?.signal?.throwIfAborted();
			const failed = latestAssistantMessage(agent.state.messages);
			if (!failed || hasReplayUnsafeAssistantOutput(failed)) return;
			const isOverflow = AIError.isContextOverflow(failed, contextWindow);
			if (isOverflow && overflowRecoveryCount < 1) {
				overflowRecoveryCount += 1;
				if (agent.state.messages.at(-1) === failed) agent.popMessage();
				agent.replaceMessages(compactRecoveryMessages(agent.state.messages, overflowRecoveryPrompt));
				await agent.continue();
				continue;
			}
			const errorId = AIError.classifyMessage(failed);
			if (isOverflow || !AIError.retriable(errorId) || transientRetryCount >= 2) return;
			transientRetryCount += 1;
			if (agent.state.messages.at(-1) === failed) agent.popMessage();
			await waitForRetry(transientRetryCount === 1 ? 300 : 900, request.callbacks?.signal);
			await agent.continue();
		}
	};

	try {
		if (request.callbacks?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		await promptWithRecovery(
			userPrompt,
			requiredStoryFiles ? { toolChoice: { type: "function", name: "list_story_files" } } : undefined,
		);
		request.callbacks?.signal?.throwIfAborted();

		const configuredThinkingLevel = agent.state.thinkingLevel;
		const configuredDisableReasoning = agent.state.disableReasoning;
		let outputLimitRecoveries = 0;
		const recoverOutputLimit = async (): Promise<void> => {
			while (
				!toolState.question &&
				!toolState.submission &&
				latestAssistantMessage(agent.state.messages)?.stopReason === "length" &&
				outputLimitRecoveries < 2
			) {
				outputLimitRecoveries += 1;
				const remainingFiles = Math.max(0, requiredStoryFiles - toolState.storyFiles.written().length);
				const forceTool = outputLimitRecoveries >= 2
					? remainingFiles > 0
						? "write_story_file"
						: "submit_story_result"
					: undefined;
				agent.setThinkingLevel(undefined);
				agent.setDisableReasoning(true);
				try {
					await promptWithRecovery(
						outputLimitRecoveries === 1
							? "系统续跑：上一轮因达到单次输出 Token 上限而被截断。沿用已经完成的分析，不要从头重复思考；立即完成尚未执行的工具调用，并给出可见的最终答复。"
							: "系统强制收尾：输出额度已再次耗尽。停止继续展开分析，立即完成必要的文件工具调用；若工作已完成，调用 submit_story_result 提交当前最佳结果。",
						forceTool ? { toolChoice: { type: "function", name: forceTool } } : undefined,
					);
					request.callbacks?.signal?.throwIfAborted();
				} finally {
					agent.setThinkingLevel(configuredThinkingLevel);
					agent.setDisableReasoning(configuredDisableReasoning === true);
				}
			}
		};
		await recoverOutputLimit();
		let validationAttempts = 0;
		while (
			requiredStoryFiles > toolState.storyFiles.written().length &&
			!toolState.question &&
			validationAttempts < requiredStoryFiles
		) {
			const before = toolState.storyFiles.written().length;
			const remaining = requiredStoryFiles - before;
			toolState.submission = undefined;
			await promptWithRecovery(
				`系统执行校验：用户要求实际创建或修改作品文件，但目前只成功写入 ${before} 份，至少还需 ${remaining} 份。现在必须调用 write_story_file 写入一份尚未完成的文件；不要只描述计划，也不要在达到数量前提交结果。`,
				{ toolChoice: { type: "function", name: "write_story_file" } },
			);
			request.callbacks?.signal?.throwIfAborted();
			validationAttempts += 1;
			if (toolState.storyFiles.written().length <= before) break;
		}
		await recoverOutputLimit();
		await callbackQueue;
		if (agent.state.error) {
			throw new Error(agent.state.error);
		}
		const messages = agent.state.messages;
		if (!toolState.question && !toolState.submission && latestAssistantMessage(messages)?.stopReason === "length") {
			throw new Error("模型已连续两次达到输出 Token 上限，仍未生成完整结果；请提高最大输出 Tokens 或降低思考强度后重试。");
		}
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
	input: { existingSummary?: string; messages?: unknown[]; instructions?: string },
	callbacks: StoryAgentCallbacks = {},
): Promise<{ status: "completed"; summary: string }> {
	const result = await runRuntime({
		mode: "compact",
		message: "压缩创作会话",
		skillName: "story",
		payload: {
			existingSummary: input.existingSummary ?? "",
			messages: input.messages ?? [],
			instructions: input.instructions ?? "",
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
