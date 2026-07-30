/**
 * Proto builders for the modern Cursor CLI exec frames (`ExecServerMessage`
 * 27-31, 36-38, 40-55).
 *
 * Split out of `cursor.ts` because these are pure `create(...)` shapes with no
 * transport, stream, or block-state coupling: the dispatcher decides *which*
 * answer a frame gets, this module knows *what* that answer looks like on the
 * wire. Every builder returns a result whose oneof case is set — an
 * `ExecClientMessage` carrying a result with an unset oneof is a fake success
 * the server reads as "the tool ran and produced nothing".
 */

import { create } from "@bufbuild/protobuf";
import {
	AfterAgentResponseRequestResponseSchema,
	AfterAgentThoughtRequestResponseSchema,
	BeforeSubmitPromptRequestResponseSchema,
	type ExecuteHookRequest,
	type ExecuteHookResponse,
	ExecuteHookResponseSchema,
	type ExecuteHookResult,
	ExecuteHookResultSchema,
	type McpStateExecResult,
	McpStateExecResultSchema,
	McpStateServerSchema,
	McpStateSuccessSchema,
	type McpToolDefinition,
	PostToolUseFailureRequestResponseSchema,
	PostToolUseRequestResponseSchema,
	PreCompactRequestResponseSchema,
	PreToolUseRequestResponseSchema,
	StopRequestResponseSchema,
	SubagentStartRequestResponseSchema,
	SubagentStopRequestResponseSchema,
	YemuBashExecErrorSchema,
	type YemuBashExecResult,
	YemuBashExecResultSchema,
	YemuBashExecSuccessSchema,
	YemuEditExecErrorSchema,
	YemuEditExecRejectedSchema,
	type YemuEditExecResult,
	YemuEditExecResultSchema,
	YemuEditExecSuccessSchema,
	YemuFindExecErrorSchema,
	type YemuFindExecResult,
	YemuFindExecResultSchema,
	YemuFindExecSuccessSchema,
	YemuGrepExecErrorSchema,
	type YemuGrepExecResult,
	YemuGrepExecResultSchema,
	YemuGrepExecSuccessSchema,
	YemuLsExecErrorSchema,
	type YemuLsExecResult,
	YemuLsExecResultSchema,
	YemuLsExecSuccessSchema,
	YemuReadExecErrorSchema,
	type YemuReadExecResult,
	YemuReadExecResultSchema,
	YemuReadExecSuccessSchema,
	type YemuTruncation,
	YemuTruncationSchema,
	YemuWriteExecErrorSchema,
	YemuWriteExecRejectedSchema,
	type YemuWriteExecResult,
	YemuWriteExecResultSchema,
	YemuWriteExecSuccessSchema,
} from "@yemu/model-catalog/discovery/cursor-gen/agent_pb";
import type { ToolResultMessage } from "../../types";

/**
 * The pure arg translation lives in `../cursor-yemu-args` so the legacy yemu shim
 * can share it without pulling this module's protobuf graph into the bundled
 * virtual registry. Re-exported here because this is where the frame builders
 * and their translation are consumed together.
 */
export {
	yemuEscapeRegexLiteral,
	yemuGrepSkip,
	yemuJoinPath,
	yemuLimit,
	yemuLsPath,
	yemuReadDisplayPath,
	yemuReadPath,
	yemuTimeout,
} from "../cursor-yemu-args";

/** Flatten a tool result's content into the single `output` string the YeMu frames carry. */
export function yemuOutputText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

/**
 * Read one field off a tool result's `details` bag, or off a nested object
 * inside it.
 *
 * `details` is `unknown` by design — every tool ships its own shape — so each
 * read is narrowed rather than asserted, and the caller decides what a value of
 * the wrong type means.
 */
function bagValue(bag: unknown, key: string): unknown {
	if (!bag || typeof bag !== "object" || !(key in bag)) return undefined;
	return Reflect.get(bag, key);
}

/**
 * A positive integer count from `details`, or `undefined`.
 *
 * The YeMu frames model their limit counters as `optional uint32`: zero means
 * "the limit was reached at zero results", so a missing, non-numeric, or
 * non-positive value must stay unset rather than be sent as 0.
 */
function detailCount(toolResult: ToolResultMessage, key: string): number | undefined {
	const value = bagValue(toolResult.details, key);
	return positiveCount(value);
}

function positiveCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * The entry cap a listing hit, from either shape a local tool records it in.
 *
 * `glob` sets a flat `details.resultLimitReached` alongside the structured
 * meta; `read` — which serves `yemu_ls` — records the cap only through
 * `OutputMeta` at `details.meta.limits.resultLimit.reached`. Reading just the
 * flat field dropped `entry_limit_reached` for every real listing, so Cursor
 * received clipped output with no incompleteness signal.
 */
function resultLimitReached(toolResult: ToolResultMessage): number | undefined {
	const flat = detailCount(toolResult, "resultLimitReached");
	if (flat !== undefined) return flat;
	const limits = bagValue(bagValue(toolResult.details, "meta"), "limits");
	return positiveCount(bagValue(bagValue(limits, "resultLimit"), "reached"));
}

/**
 * Translate a local tool's truncation summary into `YemuTruncation`.
 *
 * Two shapes reach here. `read`/`grep` set `details.truncation`
 * (`TruncationResult`), which carries an explicit `truncated` boolean. `bash`
 * sets `details.meta.truncation` (`TruncationMeta`), which has **no** such
 * flag — its presence *is* the signal, and requiring the boolean silently
 * dropped every Bash truncation, handing Cursor clipped output with no notice
 * that it was clipped.
 *
 * Returns `undefined` when nothing was truncated: the field is `optional` on
 * every YeMu success message, and emitting a zeroed `YemuTruncation` would tell the
 * server the output was trimmed to nothing.
 */
export function yemuTruncation(toolResult: ToolResultMessage): YemuTruncation | undefined {
	const direct = bagValue(toolResult.details, "truncation");
	// `TruncationResult` is authoritative when present and explicitly false.
	const truncation = direct !== undefined ? direct : bagValue(bagValue(toolResult.details, "meta"), "truncation");
	if (truncation === undefined || truncation === null) return undefined;
	// `TruncationResult` gates on its flag; `TruncationMeta` has none and is
	// only ever attached when output was actually trimmed.
	const flag = bagValue(truncation, "truncated");
	if (flag !== undefined && flag !== true) return undefined;
	const truncatedBy = bagValue(truncation, "truncatedBy");
	const totalLines = bagValue(truncation, "totalLines");
	const outputLines = bagValue(truncation, "outputLines");
	const outputBytes = bagValue(truncation, "outputBytes");
	return create(YemuTruncationSchema, {
		truncated: true,
		truncatedBy: typeof truncatedBy === "string" ? truncatedBy : "",
		totalLines: typeof totalLines === "number" ? totalLines : 0,
		outputLines: typeof outputLines === "number" ? outputLines : 0,
		outputBytes: typeof outputBytes === "number" ? outputBytes : 0,
		firstLineExceedsLimit: bagValue(truncation, "firstLineExceedsLimit") === true,
		lastLinePartial: bagValue(truncation, "lastLinePartial") === true,
	});
}

export function buildYemuReadResult(toolResult: ToolResultMessage): YemuReadExecResult {
	const text = yemuOutputText(toolResult);
	if (toolResult.isError) return buildYemuReadError(text || "Read failed");
	return create(YemuReadExecResultSchema, {
		result: {
			case: "success",
			value: create(YemuReadExecSuccessSchema, { output: text, truncation: yemuTruncation(toolResult) }),
		},
	});
}

export function buildYemuReadError(error: string): YemuReadExecResult {
	return create(YemuReadExecResultSchema, {
		result: { case: "error", value: create(YemuReadExecErrorSchema, { error }) },
	});
}

export function buildYemuBashResult(toolResult: ToolResultMessage): YemuBashExecResult {
	const text = yemuOutputText(toolResult);
	const truncation = yemuTruncation(toolResult);
	if (toolResult.isError) {
		return create(YemuBashExecResultSchema, {
			result: {
				case: "error",
				value: create(YemuBashExecErrorSchema, { error: text || "Command failed", truncation }),
			},
		});
	}
	return create(YemuBashExecResultSchema, {
		result: {
			case: "success",
			value: create(YemuBashExecSuccessSchema, { output: text, truncation }),
		},
	});
}

export function buildYemuBashError(error: string): YemuBashExecResult {
	return create(YemuBashExecResultSchema, {
		result: { case: "error", value: create(YemuBashExecErrorSchema, { error }) },
	});
}

/**
 * `YemuEditExecSuccess` requires `diff` and `patch` alongside `output`. The local
 * `edit` tool reports them under `details`; when it does not, the strings stay
 * empty rather than being faked from the output text.
 */
export function buildYemuEditResult(toolResult: ToolResultMessage): YemuEditExecResult {
	const text = yemuOutputText(toolResult);
	if (toolResult.isError) return buildYemuEditError(text || "Edit failed");
	const diff = bagValue(toolResult.details, "diff");
	const patch = bagValue(toolResult.details, "patch");
	return create(YemuEditExecResultSchema, {
		result: {
			case: "success",
			value: create(YemuEditExecSuccessSchema, {
				output: text,
				diff: typeof diff === "string" ? diff : "",
				patch: typeof patch === "string" ? patch : "",
				firstChangedLine: detailCount(toolResult, "firstChangedLine"),
			}),
		},
	});
}

export function buildYemuEditError(error: string): YemuEditExecResult {
	return create(YemuEditExecResultSchema, {
		result: { case: "error", value: create(YemuEditExecErrorSchema, { error }) },
	});
}

/**
 * A refusal is not an execution failure: `YemuEditExecResult` models them as
 * separate variants, and answering a denied call with `error` reads as "the
 * edit ran and broke", which invites a retry of an operation that was never
 * permitted.
 */
export function buildYemuEditRejected(reason: string): YemuEditExecResult {
	return create(YemuEditExecResultSchema, {
		result: { case: "rejected", value: create(YemuEditExecRejectedSchema, { reason }) },
	});
}

export function buildYemuWriteResult(toolResult: ToolResultMessage): YemuWriteExecResult {
	const text = yemuOutputText(toolResult);
	if (toolResult.isError) return buildYemuWriteError(text || "Write failed");
	return create(YemuWriteExecResultSchema, {
		result: { case: "success", value: create(YemuWriteExecSuccessSchema, { output: text }) },
	});
}

export function buildYemuWriteError(error: string): YemuWriteExecResult {
	return create(YemuWriteExecResultSchema, {
		result: { case: "error", value: create(YemuWriteExecErrorSchema, { error }) },
	});
}

/** Same variant split as {@link buildYemuEditRejected}. */
export function buildYemuWriteRejected(reason: string): YemuWriteExecResult {
	return create(YemuWriteExecResultSchema, {
		result: { case: "rejected", value: create(YemuWriteExecRejectedSchema, { reason }) },
	});
}

export function buildYemuGrepResult(toolResult: ToolResultMessage): YemuGrepExecResult {
	const text = yemuOutputText(toolResult);
	if (toolResult.isError) return buildYemuGrepError(text || "Grep failed");
	const matchLimitReached = detailCount(toolResult, "perFileLimitReached");
	return create(YemuGrepExecResultSchema, {
		result: {
			case: "success",
			value: create(YemuGrepExecSuccessSchema, {
				output: text,
				truncation: yemuTruncation(toolResult) ?? grepInternalCapTruncation(toolResult, text, matchLimitReached),
				matchLimitReached,
				linesTruncated: bagValue(toolResult.details, "linesTruncated") === true,
			}),
		},
	});
}

/**
 * The one grep cap that reaches Cursor through no other field.
 *
 * `GrepTool` folds every cap into the flat `details.truncated`, but only
 * populates `details.truncation` when the output text itself was trimmed and
 * `perFileLimitReached` when a per-file or explicit total cap fired. Its native
 * backend's own ceiling (`INTERNAL_TOTAL_CAP`) sets neither, so a search that
 * hit it answered as an unqualified success over incomplete results — the one
 * failure mode a caller cannot detect and cannot retry around.
 *
 * Only consulted once the specific signals came back empty, so a cap that did
 * report itself is never restated. `totalLines` stays 0: the flat flag says
 * that results were dropped, not how many there were.
 */
function grepInternalCapTruncation(
	toolResult: ToolResultMessage,
	text: string,
	matchLimitReached: number | undefined,
): YemuTruncation | undefined {
	if (matchLimitReached !== undefined) return undefined;
	if (bagValue(toolResult.details, "truncated") !== true) return undefined;
	return create(YemuTruncationSchema, {
		truncated: true,
		truncatedBy: "matches",
		totalLines: 0,
		outputLines: text ? text.split("\n").length : 0,
		outputBytes: Buffer.byteLength(text, "utf-8"),
		firstLineExceedsLimit: false,
		lastLinePartial: false,
	});
}

export function buildYemuGrepError(error: string): YemuGrepExecResult {
	return create(YemuGrepExecResultSchema, {
		result: { case: "error", value: create(YemuGrepExecErrorSchema, { error }) },
	});
}

export function buildYemuFindResult(toolResult: ToolResultMessage): YemuFindExecResult {
	const text = yemuOutputText(toolResult);
	if (toolResult.isError) return buildYemuFindError(text || "Find failed");
	return create(YemuFindExecResultSchema, {
		result: {
			case: "success",
			value: create(YemuFindExecSuccessSchema, {
				output: text,
				truncation: yemuTruncation(toolResult),
				resultLimitReached: resultLimitReached(toolResult),
			}),
		},
	});
}

export function buildYemuFindError(error: string): YemuFindExecResult {
	return create(YemuFindExecResultSchema, {
		result: { case: "error", value: create(YemuFindExecErrorSchema, { error }) },
	});
}

export function buildYemuLsResult(toolResult: ToolResultMessage): YemuLsExecResult {
	const text = yemuOutputText(toolResult);
	if (toolResult.isError) return buildYemuLsError(text || "Ls failed");
	return create(YemuLsExecResultSchema, {
		result: {
			case: "success",
			value: create(YemuLsExecSuccessSchema, {
				output: text,
				truncation: yemuTruncation(toolResult),
				entryLimitReached: resultLimitReached(toolResult),
			}),
		},
	});
}

export function buildYemuLsError(error: string): YemuLsExecResult {
	return create(YemuLsExecResultSchema, {
		result: { case: "error", value: create(YemuLsExecErrorSchema, { error }) },
	});
}

/**
 * Answer `mcpStateExecArgs` (frame 36) from the catalog already advertised in
 * `RequestContext.tools`.
 *
 * This client hosts no MCP servers of its own: every forwarded tool is a local
 * yemu-agent tool published under a synthetic `providerIdentifier`. Regrouping
 * the same list keeps the server's view of "which servers exist and what do
 * they expose" consistent with what it was told at context time, instead of
 * claiming zero servers while tool calls for them keep arriving.
 *
 * `serverIdentifiers` filters the answer when the server asks about specific
 * servers. `kickOnly` is a restart request — there is nothing to restart, so it
 * is answered with the same state rather than an error.
 */
export function buildMcpStateResult(
	tools: McpToolDefinition[],
	serverIdentifiers: readonly string[],
): McpStateExecResult {
	const byProvider = new Map<string, McpToolDefinition[]>();
	for (const tool of tools) {
		const identifier = tool.providerIdentifier;
		const existing = byProvider.get(identifier);
		if (existing) existing.push(tool);
		else byProvider.set(identifier, [tool]);
	}

	const wanted = serverIdentifiers.length > 0 ? new Set(serverIdentifiers) : undefined;
	const servers = [];
	for (const [identifier, serverTools] of byProvider) {
		if (wanted && !wanted.has(identifier)) continue;
		servers.push(
			create(McpStateServerSchema, {
				serverName: identifier,
				serverIdentifier: identifier,
				tools: serverTools,
				status: "connected",
			}),
		);
	}

	return create(McpStateExecResultSchema, {
		result: { case: "success", value: create(McpStateSuccessSchema, { servers }) },
	});
}

/**
 * Build the neutral response for a hook query: the matching response case with
 * every field unset.
 *
 * This client runs no Cursor hooks, and every field of every response variant
 * is `optional` — so an empty response of the right case means "no hook had
 * anything to say", which is exactly true. It is NOT the unset-oneof fake
 * success: the case itself is set, only the payload is empty.
 *
 * `ExecuteHookRequest` and `ExecuteHookResponse` are parallel oneofs whose case
 * names line up, but the two unions are unrelated to the compiler: a `switch`
 * is what makes each pairing individually type-checked, and it forces a
 * deliberate branch when a future regen adds a request case.
 *
 * Returns `null` for a request case this build does not model, which the
 * dispatcher answers with `ExecClientThrow` rather than guessing a case.
 */
export function buildNeutralHookResult(request: ExecuteHookRequest | undefined): ExecuteHookResult | null {
	let response: ExecuteHookResponse;
	switch (request?.request.case) {
		case "preCompact":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "preCompact", value: create(PreCompactRequestResponseSchema, {}) },
			});
			break;
		case "subagentStart":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "subagentStart", value: create(SubagentStartRequestResponseSchema, {}) },
			});
			break;
		case "subagentStop":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "subagentStop", value: create(SubagentStopRequestResponseSchema, {}) },
			});
			break;
		case "preToolUse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "preToolUse", value: create(PreToolUseRequestResponseSchema, {}) },
			});
			break;
		case "postToolUse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "postToolUse", value: create(PostToolUseRequestResponseSchema, {}) },
			});
			break;
		case "postToolUseFailure":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "postToolUseFailure", value: create(PostToolUseFailureRequestResponseSchema, {}) },
			});
			break;
		case "beforeSubmitPrompt":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "beforeSubmitPrompt", value: create(BeforeSubmitPromptRequestResponseSchema, {}) },
			});
			break;
		case "afterAgentResponse":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "afterAgentResponse", value: create(AfterAgentResponseRequestResponseSchema, {}) },
			});
			break;
		case "afterAgentThought":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "afterAgentThought", value: create(AfterAgentThoughtRequestResponseSchema, {}) },
			});
			break;
		case "stop":
			response = create(ExecuteHookResponseSchema, {
				response: { case: "stop", value: create(StopRequestResponseSchema, {}) },
			});
			break;
		default:
			return null;
	}
	return create(ExecuteHookResultSchema, { response });
}
