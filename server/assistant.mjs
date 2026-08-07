// Assistant bridge: drives the real Claude Code CLI binary in headless mode
// (`-p` + stream-json) and relays its structured events to the web shell.
// The frontend renders a custom chat UI; the CLI is the agent kernel.
//
// Wire protocol (JSON text frames):
//   client -> server:
//     {"type":"user_message","text":"..."}
//     {"type":"answer","text":"..."}        answer to an AskUserQuestion card
//     {"type":"stop"}                        abort the running turn
//     {"type":"new_session"}                 start a fresh conversation
//     {"type":"resume","sessionId":"..."}    resume a stored session
//   server -> client:
//     {"type":"session","sessionId":"...","model":"...","new":true}
//     {"type":"stream","event":{...}}        raw CLI stream-json event
//     {"type":"question","id":"...","question":{...}}
//     {"type":"status","running":bool,"message":"..."}
//     {"type":"exited","code":...}

import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configPathForUser, ensureUserWorkspace, projectPathFor, seedCliConfig } from "./workspace.mjs";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const CLI_BINARY =
	process.env.YEMU_CLI_BINARY ||
	path.resolve(serverDir, "..", "node_modules", "@anthropic-ai", "claude-agent-sdk-linux-x64", "claude");

const MAX_OUTPUT_EVENTS = 5000;
const MAX_PROMPT_LENGTH = 20_000;
const TURN_TIMEOUT_MS = 20 * 60 * 1000;

class TurnRunner {
	constructor({ sessionId, cwd, env, extraArgs, prompt, onEvent, onExit }) {
		this.sessionId = sessionId;
		this.cwd = cwd;
		this.env = env;
		this.extraArgs = extraArgs || [];
		this.prompt = prompt;
		this.onEvent = onEvent;
		this.onExit = onExit;
		this.child = null;
		this.finished = false;
	}

	start() {
		const args = [
			"-p",
			this.prompt,
			"--output-format",
			"stream-json",
			"--verbose",
			"--max-turns",
			"64",
			...(this.sessionId ? ["--resume", this.sessionId] : []),
			...this.extraArgs,
		];
		this.child = spawn(CLI_BINARY, args, {
			cwd: this.cwd,
			env: this.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let buffer = "";
		let eventCount = 0;
		this.child.stdout.on("data", chunk => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			while (newline !== -1) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (!line) continue;
				if (eventCount++ >= MAX_OUTPUT_EVENTS) continue;
				try {
					this.onEvent(JSON.parse(line));
				} catch {
					// Ignore non-JSON diagnostic output from the CLI process.
				}
			}
		});
		let stderrTail = "";
		this.child.stderr.on("data", chunk => {
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000);
		});
		const finish = code => {
			if (this.finished) return;
			this.finished = true;
			this.onExit?.({ code, stderr: stderrTail });
		};
		this.child.on("error", () => finish(-1));
		this.child.on("close", code => finish(code ?? -1));
		this.timeout = setTimeout(() => {
			try {
				this.child.kill("SIGTERM");
			} catch {
				// Process already gone.
			}
		}, TURN_TIMEOUT_MS);
		this.timeout.unref?.();
	}

	stop() {
		if (this.finished || !this.child) return;
		try {
			this.child.kill("SIGTERM");
		} catch {
			// Process already gone.
		}
	}
}

class Conversation {
	constructor({ userId, projectId, projectDir, env, resolveCliEnv }) {
		this.userId = userId;
		this.projectId = projectId;
		this.projectDir = projectDir;
		this.env = env;
		this.resolveCliEnv = resolveCliEnv;
		this.sessionId = null;
		this.model = "";
		this.clients = new Set();
		this.runner = null;
		this.question = null;
		this.pendingMessages = [];
	}

	broadcast(message) {
		const serialized = JSON.stringify(message);
		for (const client of this.clients) {
			try {
				if (client.readyState === 1) client.send(serialized);
			} catch {
				// Socket may be closing.
			}
		}
	}

	statusMessage(message) {
		this.broadcast({ type: "status", running: Boolean(this.runner), message });
	}

	handleTurnExit({ code, stderr }) {
		this.runner = null;
		if (this.question && code !== 0 && !this.pendingMessages.length) {
			// Turn ended while a question was pending; keep waiting for the answer.
			this.statusMessage("等待你的回答…");
			return;
		}
		if (this.question) {
			this.question = null;
		}
		this.statusMessage(code === 0 ? "" : `CLI 退出码 ${code}${stderr ? `：${stderr.trim().slice(0, 200)}` : ""}`);
		if (this.pendingMessages.length > 0 && code === 0) {
			const next = this.pendingMessages.shift();
			void this.submit(next);
		}
	}

	async submit(text) {
		const prompt = String(text ?? "")
			.trim()
			.slice(0, MAX_PROMPT_LENGTH);
		if (!prompt) return;
		if (this.runner) {
			this.pendingMessages.push(prompt);
			this.statusMessage("上一条任务仍在执行，已排队等待");
			return;
		}
		this.question = null;
		this.broadcast({ type: "status", running: true, message: "" });
		const env = { ...this.env, ...(await this.resolveCliEnv(this.userId).catch(() => ({}))) };
		this.runner = new TurnRunner({
			sessionId: this.sessionId,
			cwd: this.projectDir,
			env,
			prompt,
			onEvent: event => {
				if (event.type === "system" && event.subtype === "init") {
					if (event.session_id && !this.sessionId) this.sessionId = event.session_id;
					if (event.model) this.model = String(event.model);
				}
				if (event.type === "assistant" && Array.isArray(event.message?.content)) {
					const questionBlock = event.message.content.find(
						block => block.type === "tool_use" && block.name === "AskUserQuestion",
					);
					if (questionBlock && !this.question) {
						this.question = {
							id: questionBlock.id,
							toolUseId: questionBlock.id,
							question: questionBlock.input?.question || "需要你确认一个选择",
							options: Array.isArray(questionBlock.input?.options) ? questionBlock.input.options : [],
							multiSelect: questionBlock.input?.multiSelect === true,
						};
						this.broadcast({ type: "question", id: this.question.id, question: this.question });
					}
				}
				this.broadcast({ type: "stream", event });
			},
			onExit: result => this.handleTurnExit(result),
		});
		this.runner.start();
	}

	answer(text) {
		const question = this.question;
		if (!question) {
			this.statusMessage("当前没有等待回答的问题");
			return;
		}
		this.question = null;
		void this.submit(String(Array.isArray(text) ? text.join("、") : (text ?? "")));
	}

	stop() {
		if (this.runner) {
			this.runner.stop();
			this.statusMessage("已发送停止指令");
		}
	}

	newSession() {
		this.sessionId = null;
		this.question = null;
		this.broadcast({ type: "session", sessionId: null, new: true });
		this.statusMessage("已开启新会话");
	}

	resume(sessionId) {
		if (!sessionId) return;
		this.sessionId = String(sessionId);
		this.question = null;
		this.broadcast({ type: "session", sessionId: this.sessionId, new: false });
		this.statusMessage(`已恢复会话 ${this.sessionId.slice(0, 8)}`);
	}

	attach(client) {
		this.clients.add(client);
		this.broadcastSession(client);
		if (this.runner) this.broadcastTo(client, { type: "status", running: true });
		if (this.question) this.broadcastTo(client, { type: "question", id: this.question.id, question: this.question });
	}

	broadcastSession(client) {
		const message = { type: "session", sessionId: this.sessionId, model: this.model, running: Boolean(this.runner) };
		this.broadcastTo(client, message);
	}

	broadcastTo(client, message) {
		try {
			if (client.readyState === 1) client.send(JSON.stringify(message));
		} catch {
			// Socket may be closing.
		}
	}

	detach(client) {
		this.clients.delete(client);
	}
}

export class AssistantBridge {
	constructor({ resolveUserEnv } = {}) {
		this.resolveUserEnv = resolveUserEnv || (async () => ({}));
		this.conversations = new Map();
	}

	keyFor(userId, projectId) {
		return `${userId}:${projectId}`;
	}

	async getConversation(userId, projectId) {
		const key = this.keyFor(userId, projectId);
		let conversation = this.conversations.get(key);
		if (!conversation) {
			await ensureUserWorkspace(userId);
			await seedCliConfig(userId);
			const projectDir = projectPathFor(userId, projectId);
			conversation = new Conversation({
				userId,
				projectId,
				projectDir,
				env: this.baseEnv(userId),
				resolveCliEnv: this.resolveUserEnv,
			});
			this.conversations.set(key, conversation);
		}
		return conversation;
	}

	baseEnv(userId) {
		const configDir = configPathForUser(userId);
		return {
			TERM: "xterm-256color",
			CLAUDE_CONFIG_DIR: configDir,
			HOME: configDir,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			DISABLE_TELEMETRY: "1",
		};
	}

	async attach(userId, projectId, client) {
		const conversation = await this.getConversation(userId, projectId);
		conversation.attach(client);
	}

	detach(userId, projectId, client) {
		const conversation = this.conversations.get(this.keyFor(userId, projectId));
		if (conversation) conversation.detach(client);
	}

	input(userId, projectId, client, message) {
		const conversation = this.conversations.get(this.keyFor(userId, projectId));
		if (!conversation?.clients.has(client)) return;
		if (message.type === "user_message") {
			void conversation.submit(message.text);
		} else if (message.type === "answer") {
			conversation.answer(message.text);
		} else if (message.type === "stop") {
			conversation.stop();
		} else if (message.type === "new_session") {
			conversation.newSession();
		} else if (message.type === "resume") {
			conversation.resume(message.sessionId);
		}
	}

	status(userId, projectId) {
		const conversation = this.conversations.get(this.keyFor(userId, projectId));
		return conversation
			? {
					running: Boolean(conversation.runner),
					sessionId: conversation.sessionId,
					clients: conversation.clients.size,
				}
			: { running: false, sessionId: null, clients: 0 };
	}

	disconnect(userId, projectId) {
		const conversation = this.conversations.get(this.keyFor(userId, projectId));
		if (conversation) {
			conversation.clients.clear();
			if (!conversation.runner && !conversation.clients.size) {
				this.conversations.delete(this.keyFor(userId, projectId));
			}
		}
	}

	/**
	 * List stored CLI sessions for a project (the CLI persists one .jsonl per
	 * session under CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/).
	 */
	async listSessions(userId, projectId) {
		const projectDir = projectPathFor(userId, projectId);
		const projectsRoot = path.join(configPathForUser(userId), "projects");
		const entries = await readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
		const sessions = [];
		for (const dir of entries) {
			if (!dir.isDirectory()) continue;
			const files = await readdir(path.join(projectsRoot, dir.name)).catch(() => []);
			for (const file of files) {
				if (!file.endsWith(".jsonl")) continue;
				const sessionId = file.replace(/\.jsonl$/u, "");
				const filePath = path.join(projectsRoot, dir.name, file);
				let preview = "";
				let sessionCwd = "";
				try {
					const lines = (await readFile(filePath, "utf8")).split("\n").slice(0, 400);
					for (const line of lines) {
						if (!line.trim()) continue;
						let event;
						try {
							event = JSON.parse(line);
						} catch {
							continue;
						}
						if (event.type === "system" && event.subtype === "init") {
							sessionCwd = String(event.cwd || "");
							break;
						}
					}
					for (const line of lines) {
						if (!line.trim()) continue;
						let event;
						try {
							event = JSON.parse(line);
						} catch {
							continue;
						}
						if (event.type === "user" && Array.isArray(event.message?.content)) {
							preview = event.message.content
								.filter(block => typeof block.text === "string")
								.map(block => block.text)
								.join(" ")
								.trim()
								.slice(0, 120);
							if (preview) break;
						}
					}
				} catch {
					continue;
				}
				const fileStat = await stat(filePath).catch(() => null);
				if (sessionCwd === projectDir) {
					sessions.push({
						id: sessionId,
						title: preview || "（空会话）",
						updatedAt: fileStat?.mtime?.toISOString?.() || null,
					});
				}
			}
		}
		return sessions
			.sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
			.slice(0, 50);
	}

	shutdown() {
		for (const conversation of this.conversations.values()) {
			conversation.stop();
		}
		this.conversations.clear();
	}
}
