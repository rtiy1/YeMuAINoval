import { $flag } from "@yemu/utils";
import type { ToolSession } from ".";

export interface EvalBackendsAllowance {
	python: boolean;
	js: boolean;
	ruby: boolean;
	julia: boolean;
}

/** Read per-backend allowance from settings (py/js default on; rb/jl opt-in, default off). */
export function readEvalBackendsAllowance(session: ToolSession): EvalBackendsAllowance {
	return {
		python: session.settings.get("eval.py") ?? true,
		js: session.settings.get("eval.js") ?? true,
		ruby: session.settings.get("eval.rb") ?? false,
		julia: session.settings.get("eval.jl") ?? false,
	};
}

/**
 * Materialize the active eval backend allowance: YEMU_PY / YEMU_JS / YEMU_RB / YEMU_JL
 * env flags override the per-key settings; otherwise settings win (py/js default
 * on, rb/jl default off).
 */
export function resolveEvalBackends(session: ToolSession): EvalBackendsAllowance {
	const settings = readEvalBackendsAllowance(session);
	return {
		python: $flag("YEMU_PY", settings.python),
		js: $flag("YEMU_JS", settings.js),
		ruby: $flag("YEMU_RB", settings.ruby),
		julia: $flag("YEMU_JL", settings.julia),
	};
}
