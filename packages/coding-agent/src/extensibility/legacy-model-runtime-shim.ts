/**
 * Compatibility shim for legacy extensions importing the package root of
 * `@yemu/model-runtime` (or one of its aliased scopes like `@yemu/model-runtime`
 * or `@yemu/model-runtime`).
 *
 * model-runtime 15.1.0 removed the historical TypeBox root exports (`Type`, plus the
 * runtime-relevant half of the `Static`/`TSchema` pair) from the package
 * entrypoint. Legacy extensions still author parameter schemas as
 * `Type.Object({ ... })`, so this file is served by `legacy-agent-compat.ts` in
 * place of the real model-runtime entrypoint whenever a legacy extension imports the
 * bare package root. Subpath imports (`@yemu/model-runtime/oauth`, etc.)
 * continue to resolve directly against the bundled model-runtime package.
 *
 * The `Type` runtime and legacy `StringEnum()` helper are borrowed from the
 * Zod-backed TypeBox shim that already serves TypeBox imports for the same
 * extension class, keeping the legacy-compat surface internally consistent.
 *
 * Type-level `Static` and `TSchema` continue to come from model-runtime's own
 * `types.ts` via the `export *` below — model-runtime still exports both as types,
 * only the runtime `Type` builder and `StringEnum()` helper were removed.
 */

import type { Effort } from "@yemu/model-catalog/effort";
import { clampThinkingLevelForModel } from "@yemu/model-catalog/model-thinking";
import {
	calculateCost,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	modelsAreEqual,
} from "@yemu/model-catalog/models";
import type { Api, AssistantMessage, Model } from "@yemu/model-runtime";
import { type TSchema, Type } from "./typebox";

export interface StringEnumOptions<T extends string> {
	description?: string;
	default?: T;
	examples?: T[];
	[key: string]: unknown;
}

function stringEnumWireSchema<T extends string | number>(
	values: readonly T[] | Record<string, T>,
	options: StringEnumOptions<any> | undefined,
) {
	const enumValues = Array.isArray(values) ? [...values] : Object.values(values);
	const schema: Record<string, unknown> = {
		type: "string",
		enum: enumValues,
	};
	if (!options) return schema;
	for (const key in options) {
		if (options[key] !== undefined) {
			schema[key] = options[key];
		}
	}
	return schema;
}

export function StringEnum<T extends string | number>(
	values: readonly T[] | Record<string, T>,
	options?: StringEnumOptions<any>,
): TSchema {
	const opts = {
		description: options?.description ?? "Legacy string enum compatibility schema",
		...options,
	};
	const schema: TSchema = Array.isArray(values) && values.length === 0 ? Type.Never(opts) : Type.Enum(values, opts);
	Object.defineProperty(schema, "toJSON", {
		value: () => stringEnumWireSchema(values, options),
		enumerable: false,
		writable: true,
		configurable: true,
	});
	return schema;
}

/** Clamp a historical YeMu thinking level against YeMu's model metadata. */
export function clampThinkingLevel<TApi extends Api>(model: Model<TApi>, level: Effort | "off"): Effort | "off" {
	if (level === "off") return "off";
	return clampThinkingLevelForModel(model, level) ?? "off";
}

/**
 * Provider-error classification patterns ported verbatim from historical model-runtime
 * (`@yemu/model-runtime` `utils/retry.ts`). Legacy extensions call
 * {@link isRetryableAssistantError} to decide whether to restart a failed
 * assistant turn, so the wording tables must match the upstream semantics they
 * were authored against rather than YeMu's own `Error`-based classifiers.
 */
const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const RETRYABLE_PROVIDER_ERROR_PATTERN =
	/overloaded|rate.?limit|too many requests|429|500|502|503|504|524|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? out|timeout|terminated|websocket.?closed|websocket.?error|ended without|stream ended before message_stop|stream ended before a terminal response event|http2 request did not get a response|retry delay|you can retry your request|try your request again|please retry your request|ResourceExhausted/i;

/**
 * Compatibility implementation of historical model-runtime's `isRetryableAssistantError`.
 *
 * Classifies whether a failed assistant message looks like a transient provider
 * or transport error so legacy extensions can decide if the last assistant turn
 * should be restarted. Account/quota limits are treated as non-retryable. This
 * does not implement any retry policy; callers own budget, backoff, and reporting.
 */
export function isRetryableAssistantError(message: AssistantMessage): boolean {
	if (message.stopReason !== "error" || !message.errorMessage) return false;
	const errorMessage = message.errorMessage;
	if (NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

export * from "@yemu/model-runtime";
/**
 * Compatibility re-exports for catalog symbols that model-runtime historically exposed
 * from its own barrel prior to the `refactor(catalog)!: split model catalog
 * from model-runtime` change. Legacy extensions still import these from the model-runtime
 * root, so the shim bridges them through to their new home in
 * `@yemu/model-catalog/models`. `getModel`/`getModels` are the historical
 * model-runtime names for `getBundledModel`/`getBundledModels`; the remaining symbols
 * kept their names across the move.
 */
export { calculateCost, getBundledModel, getBundledModels, getBundledProviders, modelsAreEqual, Type };
export const getModel = getBundledModel;
export const getModels = getBundledModels;

/**
 * Compatibility re-exports for runtime helpers that upstream
 * `@yemu/model-runtime` exposed from its package root but yemu's
 * `@yemu/model-runtime` barrel no longer forwards. Each symbol still exists in the
 * host graph — only its root re-export was dropped — so bridging it here keeps
 * legacy extensions importing it from the model-runtime root resolving through Bun's
 * static named-export check (e.g. `yemu plugin install yemu-blackhole`).
 *
 * This is the full set derived from an audit of the upstream root surface: the
 * error-classification predicate `isContextOverflow` (now under
 * `@yemu/model-runtime/error`) and the JSON-repair helpers that yemu relocated to
 * `@yemu/utils`. Upstream root symbols with no yemu equivalent are
 * intentionally not shimmed — the package has diverged and there is nothing to
 * forward.
 */
export { isContextOverflow } from "@yemu/model-runtime/error";
export { parseJsonWithRepair, parseStreamingJson, repairJson } from "@yemu/utils";
