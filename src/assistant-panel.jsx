import {
	Bot,
	Check,
	ChevronDown,
	CircleHelp,
	FileText,
	Globe,
	History,
	LoaderCircle,
	PanelRight,
	Plus,
	Search,
	Send,
	Settings2,
	Square,
	StopCircle,
	UserRound,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AgentMarkdown from "./agent-markdown.jsx";
import { api, getAccessToken } from "./api";
import { getApiBase } from "./platform.mjs";

const TOOL_META = {
	Read: { label: "读取文件", icon: FileText },
	Write: { label: "写入文件", icon: FileText },
	Edit: { label: "修改文件", icon: FileText },
	Glob: { label: "查找文件", icon: Search },
	Grep: { label: "搜索内容", icon: Search },
	WebSearch: { label: "联网搜索", icon: Globe },
	WebFetch: { label: "抓取网页", icon: Globe },
	Skill: { label: "执行 Skill", icon: CircleHelp },
	Task: { label: "子任务", icon: LoaderCircle },
	TodoWrite: { label: "更新计划", icon: Check },
	Agent: { label: "子智能体", icon: Bot },
	NotebookEdit: { label: "修改文档", icon: FileText },
	Bash: { label: "执行命令", icon: Square },
	AskUserQuestion: { label: "向你提问", icon: CircleHelp },
};

function toolSummary(name, input) {
	const data = input && typeof input === "object" ? input : {};
	const file = data.file_path || data.path || data.file || "";
	if (name === "Read" && (file || data.file_path)) return data.file_path || file;
	if (name === "Write") return data.file_path || file;
	if (name === "Edit") return data.file_path || file;
	if (name === "Glob") return data.pattern || "";
	if (name === "Grep") return data.pattern || "";
	if (name === "WebSearch") return data.query || "";
	if (name === "WebFetch") return data.url || "";
	if (name === "Skill") return data.name || data.skill || "";
	if (name === "Task") return data.description || "";
	if (name === "Agent") return data.subagent_type || "";
	if (name === "TodoWrite") return Array.isArray(data.todos) ? `${data.todos.length} 项计划` : "";
	if (name === "Bash") return data.command || "";
	if (name === "NotebookEdit") return data.notebook_path || data.file_path || "";
	if (data.message) return data.message;
	if (data.query) return data.query;
	return "";
}

function toolDisplayName(name) {
	return TOOL_META[name]?.label || name;
}

let messageSequence = 0;
const nextMessageId = () => `msg-${Date.now()}-${messageSequence++}`;

export default function AssistantPanel({
	projectId,
	projectTitle = "",
	chapterTitle = "",
	chapterFile = "",
	defaultModel = "",
	onCollapse,
	onNotify,
}) {
	const socketRef = useRef(null);
	const reconnectTimerRef = useRef(null);
	const reconnectAttemptRef = useRef(0);
	const scrollRef = useRef(null);
	const inputRef = useRef(null);
	const pendingAssistantRef = useRef(null);
	const closedRef = useRef(false);

	const [connected, setConnected] = useState(false);
	const [running, setRunning] = useState(false);
	const [statusText, setStatusText] = useState("");
	const [sessionId, setSessionId] = useState(null);
	const [model, setModel] = useState(defaultModel);
	const [messages, setMessages] = useState([]);
	const [question, setQuestion] = useState(null);
	const [questionAnswer, setQuestionAnswer] = useState("");
	const [input, setInput] = useState("");
	const [historyOpen, setHistoryOpen] = useState(false);
	const [historyList, setHistoryList] = useState([]);
	const [historyLoading, setHistoryLoading] = useState(false);
	const [usage, setUsage] = useState(null);
	const [modelMenuOpen, setModelMenuOpen] = useState(false);
	const [modelSaving, setModelSaving] = useState(false);

	const wsUrl = useMemo(() => {
		const base = getApiBase();
		const url = new URL(base.replace(/^http/iu, "ws"));
		url.pathname = `${url.pathname.replace(/\/+$/u, "")}/api/assistant`;
		url.searchParams.set("project", projectId);
		const token = getAccessToken();
		if (token) url.searchParams.set("token", token);
		return url.toString();
	}, [projectId]);

	const pushMessage = useCallback(message => {
		setMessages(current => [...current, message]);
	}, []);

	const updateLastAssistant = useCallback(updater => {
		setMessages(current => {
			const copy = [...current];
			const index = copy.findIndex(
				message => message.role === "assistant" && message.id === pendingAssistantRef.current?.id,
			);
			if (index === -1) return copy;
			copy[index] = updater(copy[index]);
			return copy;
		});
	}, []);

	const startAssistantMessage = useCallback(() => {
		if (pendingAssistantRef.current) return pendingAssistantRef.current;
		const message = { id: nextMessageId(), role: "assistant", text: "", toolUses: [], streaming: true, error: "" };
		pendingAssistantRef.current = message;
		pushMessage(message);
		return message;
	}, [pushMessage]);

	const handleStreamEvent = useCallback(
		event => {
			startAssistantMessage();
			const kind = event.event?.type;
			const block = event.event?.content_block;
			const delta = event.event?.delta;
			if (kind === "content_block_start" && block) {
				if (block.type === "text") {
					updateLastAssistant(current => ({ ...current, text: current.text + (block.text || "") }));
				} else if (block.type === "tool_use") {
					updateLastAssistant(current => ({
						...current,
						toolUses: [...current.toolUses, { id: block.id, name: block.name, input: {}, status: "running" }],
					}));
				}
			} else if (kind === "content_block_delta") {
				if (delta?.type === "text_delta") {
					updateLastAssistant(current => ({ ...current, text: current.text + (delta.text || "") }));
				} else if (delta?.type === "input_json_delta") {
					updateLastAssistant(current => {
						const toolUses = [...current.toolUses];
						const last = toolUses.at(-1);
						if (!last) return current;
						try {
							const parsed = JSON.parse((last.rawJson || "") + (delta.partial_json || ""));
							last.rawJson = "";
							last.input = { ...(last.input || {}), ...parsed };
						} catch {
							last.rawJson = (last.rawJson || "") + (delta.partial_json || "");
						}
						return { ...current, toolUses };
					});
				}
			} else if (kind === "content_block_stop") {
				// Tool input accumulation finished; nothing else needed.
			} else if (kind === "message_delta" && delta?.stop_reason === "tool_use") {
				updateLastAssistant(current => ({
					...current,
					toolUses: current.toolUses.map(tool => ({ ...tool, status: "done" })),
				}));
			}
		},
		[startAssistantMessage, updateLastAssistant],
	);

	const finalizeAssistantMessage = useCallback(
		event => {
			const message = event.message;
			const textBlocks = (message?.content || []).filter(block => block.type === "text");
			const toolBlocks = (message?.content || []).filter(block => block.type === "tool_use");
			const toolUses = toolBlocks.map(block => ({
				id: block.id,
				name: block.name,
				input: block.input || {},
				status: "done",
			}));
			if (pendingAssistantRef.current) {
				updateLastAssistant(() => ({
					id: pendingAssistantRef.current.id,
					role: "assistant",
					text: textBlocks.map(block => block.text).join(""),
					toolUses,
					streaming: false,
					error: event.is_api_error_message ? textBlocks[0]?.text || "API 调用出错" : "",
				}));
				pendingAssistantRef.current = null;
			} else if (textBlocks.length || toolUses.length) {
				pushMessage({
					id: nextMessageId(),
					role: "assistant",
					text: textBlocks.map(block => block.text).join(""),
					toolUses,
					streaming: false,
					error: event.is_api_error_message ? textBlocks[0]?.text || "API 调用出错" : "",
				});
			}
		},
		[pushMessage, updateLastAssistant],
	);

	const handleServerMessage = useCallback(
		message => {
			if (message.type === "session") {
				setSessionId(message.sessionId);
				if (message.model) setModel(message.model);
			} else if (message.type === "status") {
				setRunning(message.running === true);
				setStatusText(message.message || "");
				if (message.error) {
					onNotify?.(message.error);
				}
			} else if (message.type === "stream") {
				const event = message.event;
				if (event.type === "system" && event.subtype === "init") {
					if (event.session_id) setSessionId(event.session_id);
					if (event.model) setModel(String(event.model));
				} else if (event.type === "stream_event") {
					handleStreamEvent(event);
				} else if (event.type === "assistant") {
					finalizeAssistantMessage(event);
				} else if (event.type === "result") {
					setRunning(false);
					setUsage({
						inputTokens: event.usage?.input_tokens ?? 0,
						outputTokens: event.usage?.output_tokens ?? 0,
						cacheReadTokens: event.usage?.cache_read_input_tokens ?? 0,
						cost: event.total_cost_usd,
					});
					if (event.is_error) {
						const errorText = Array.isArray(event.errors)
							? event.errors
									.map(e => e.trim())
									.filter(Boolean)
									.join("；")
							: event.result;
						updateLastAssistant(current => ({
							...current,
							error: current.error || String(errorText || "执行出错"),
						}));
					}
				}
			} else if (message.type === "question") {
				setQuestion(message.question);
			} else if (message.type === "exited") {
				setRunning(false);
				if (message.code) setStatusText(`CLI 进程已退出（${message.code}）`);
			}
		},
		[finalizeAssistantMessage, handleStreamEvent, onNotify, updateLastAssistant],
	);

	const connect = useCallback(() => {
		if (socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING)
			return;
		const socket = new WebSocket(wsUrl, { headers: {} });
		socketRef.current = socket;
		socket.onopen = () => {
			reconnectAttemptRef.current = 0;
			setConnected(true);
		};
		socket.onmessage = event => {
			let message;
			try {
				message = JSON.parse(event.data);
			} catch {
				return;
			}
			handleServerMessage(message);
		};
		socket.onclose = () => {
			setConnected(false);
			setRunning(false);
			if (closedRef.current) return;
			const delay = Math.min(10_000, 800 * 2 ** reconnectAttemptRef.current);
			reconnectAttemptRef.current += 1;
			reconnectTimerRef.current = setTimeout(connect, delay);
		};
		socket.onerror = () => {
			socket.close();
		};
	}, [handleServerMessage, wsUrl]);

	useEffect(() => {
		connect();
		return () => {
			closedRef.current = true;
			if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
			socketRef.current?.close();
		};
	}, [connect]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 140;
		if (nearBottom) element.scrollTop = element.scrollHeight;
	}, [messages, running, question]);

	function send() {
		const text = input.trim();
		if (!text || running || !connected) return;
		if (pendingAssistantRef.current) {
			const pending = pendingAssistantRef.current;
			pendingAssistantRef.current = null;
			setMessages(current =>
				current.map(message => (message.id === pending.id ? { ...message, streaming: false } : message)),
			);
		}
		pushMessage({ id: nextMessageId(), role: "user", text });
		setInput("");
		setUsage(null);
		socketRef.current?.send(JSON.stringify({ type: "user_message", text }));
		requestAnimationFrame(() => inputRef.current?.focus());
	}

	function submitQuestion(option) {
		if (!question || running) return;
		const text = option != null ? String(option) : questionAnswer.trim();
		if (!text) return;
		setQuestion(null);
		setQuestionAnswer("");
		pushMessage({ id: nextMessageId(), role: "user", text: `回答：${text}` });
		socketRef.current?.send(JSON.stringify({ type: "answer", text }));
	}

	function stopTurn() {
		socketRef.current?.send(JSON.stringify({ type: "stop" }));
		setStatusText("正在停止…");
	}

	function startNewSession() {
		setMessages([]);
		setUsage(null);
		setQuestion(null);
		setSessionId(null);
		socketRef.current?.send(JSON.stringify({ type: "new_session" }));
		onNotify?.("已开启新会话");
	}

	async function openHistory() {
		setHistoryOpen(true);
		setHistoryLoading(true);
		try {
			const response = await api.getAssistantSessions(projectId);
			setHistoryList(response.sessions || []);
		} catch (error) {
			onNotify?.(error.message);
		} finally {
			setHistoryLoading(false);
		}
	}

	function resumeSession(session) {
		setMessages([]);
		setUsage(null);
		setQuestion(null);
		setHistoryOpen(false);
		socketRef.current?.send(JSON.stringify({ type: "resume", sessionId: session.id }));
		onNotify?.(`已恢复会话（${session.title.slice(0, 20)}）`);
	}

	async function changeModel(nextModel) {
		setModelMenuOpen(false);
		setModelSaving(true);
		try {
			await api.updateSettings({ model: nextModel });
			setModel(nextModel);
			onNotify?.("模型已更新，将在下一条消息生效");
		} catch (error) {
			onNotify?.(error.message);
		} finally {
			setModelSaving(false);
		}
	}

	const toolUsed = messages.some(message => message.toolUses?.length > 0);

	return (
		<div className="yemu-assistant">
			<div className="yemu-assistant-header">
				<div className="yemu-assistant-title">
					<span className="yemu-assistant-mark" aria-hidden="true">
						✦
					</span>
					<div className="yemu-assistant-title-copy">
						<strong>夜雨</strong>
						<small>
							{connected ? (sessionId ? `会话 ${sessionId.slice(0, 8)}` : "未开始对话") : "正在连接…"}
						</small>
					</div>
				</div>
				<div className="yemu-assistant-actions">
					<div className="yemu-model-anchor">
						<button
							className={`yemu-model-trigger ${modelMenuOpen ? "open" : ""}`}
							aria-expanded={modelMenuOpen}
							onClick={() => setModelMenuOpen(open => !open)}
							title="切换模型"
						>
							<Settings2 size={13} />
							<span>{model || "选择模型"}</span>
							{modelSaving ? <LoaderCircle size={11} className="spin" /> : <ChevronDown size={11} />}
						</button>
						{modelMenuOpen && (
							<div className="yemu-model-menu">
								<div className="yemu-model-menu-heading">
									<strong>模型</strong>
									<button type="button" aria-label="关闭" onClick={() => setModelMenuOpen(false)}>
										<X size={13} />
									</button>
								</div>
								<button type="button" className={!model ? "active" : ""} onClick={() => changeModel("")}>
									默认（跟随 CLI）
								</button>
								{["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5"].map(name => (
									<button
										type="button"
										key={name}
										className={model === name ? "active" : ""}
										onClick={() => changeModel(name)}
									>
										{name}
									</button>
								))}
								<input
									value={model}
									onChange={event => setModel(event.target.value)}
									onKeyDown={event => {
										if (event.key === "Enter") changeModel(event.currentTarget.value);
									}}
									placeholder="或输入其他模型 ID"
									aria-label="自定义模型 ID"
								/>
							</div>
						)}
					</div>
					<button className="yemu-icon-button" aria-label="会话历史" title="会话历史" onClick={openHistory}>
						<History size={15} />
					</button>
					<button
						className="yemu-icon-button"
						aria-label="新建会话"
						title="新建会话"
						onClick={startNewSession}
						disabled={running}
					>
						<Plus size={15} />
					</button>
					<button className="yemu-icon-button" aria-label="收起助手" title="收起助手" onClick={onCollapse}>
						<PanelRight size={15} />
					</button>
				</div>
			</div>

			{historyOpen ? (
				<div className="yemu-session-history">
					<div className="yemu-session-history-heading">
						<strong>会话历史</strong>
						<button
							type="button"
							className="yemu-icon-button small"
							aria-label="返回"
							onClick={() => setHistoryOpen(false)}
						>
							<X size={14} />
						</button>
					</div>
					{historyLoading ? (
						<div className="yemu-empty">
							<LoaderCircle size={18} className="spin" />
							<p>正在读取会话…</p>
						</div>
					) : historyList.length ? (
						<div className="yemu-session-list">
							{historyList.map(session => (
								<button
									type="button"
									className={`yemu-session-item ${session.id === sessionId ? "current" : ""}`}
									key={session.id}
									onClick={() => resumeSession(session)}
								>
									<span className="yemu-session-item-title">{session.title}</span>
									<span className="yemu-session-item-meta">
										{session.id.slice(0, 8)} ·{" "}
										{session.updatedAt
											? new Date(session.updatedAt).toLocaleString("zh-CN", {
													month: "numeric",
													day: "numeric",
													hour: "2-digit",
													minute: "2-digit",
												})
											: ""}
									</span>
								</button>
							))}
						</div>
					) : (
						<div className="yemu-empty">
							<p>这个作品还没有历史会话</p>
						</div>
					)}
				</div>
			) : (
				<div className="yemu-assistant-body">
					<div className="yemu-assistant-scroll" ref={scrollRef}>
						{messages.length === 0 && (
							<div className="yemu-assistant-empty">
								<div className="yemu-assistant-wordmark">
									<span>YE</span>
									<span>MU</span>
								</div>
								<p>
									<strong>和夜雨一起写</strong>
								</p>
								<p className="yemu-assistant-empty-hint">
									当前作品、章节文件与设定已经挂载。像在 CLI 里一样直接说出你的需求。
								</p>
							</div>
						)}
						{messages.map(message =>
							message.role === "user" ? (
								<div className="yemu-chat-row user" key={message.id}>
									<span className="yemu-chat-avatar user">
										<UserRound size={13} />
									</span>
									<div className="yemu-chat-bubble user">
										<p>{message.text}</p>
									</div>
								</div>
							) : (
								<div className="yemu-chat-row assistant" key={message.id}>
									<span className="yemu-chat-avatar assistant">
										<Bot size={13} />
									</span>
									<div className="yemu-chat-bubble assistant">
										{message.error && <div className="yemu-chat-error">{message.error}</div>}
										{message.text ? (
											<AgentMarkdown value={message.text} streaming={message.streaming} />
										) : message.streaming && !message.toolUses.length ? (
											<span className="yemu-chat-thinking">
												<LoaderCircle size={13} className="spin" />
												正在思考…
											</span>
										) : null}
										{message.toolUses?.length > 0 && (
											<div className="yemu-tool-list">
												{message.toolUses.map(tool => (
													<div className={`yemu-tool-item ${tool.status}`} key={tool.id}>
														<span className="yemu-tool-icon">
															{TOOL_META[tool.name]?.icon ? (
																(() => {
																	const Icon = TOOL_META[tool.name].icon;
																	return <Icon size={12} />;
																})()
															) : (
																<Square size={12} />
															)}
														</span>
														<span className="yemu-tool-name">{toolDisplayName(tool.name)}</span>
														<span className="yemu-tool-summary">
															{toolSummary(tool.name, tool.input) || "…"}
														</span>
														{tool.status === "running" ? (
															<LoaderCircle size={11} className="spin" />
														) : (
															<Check size={11} />
														)}
													</div>
												))}
											</div>
										)}
									</div>
								</div>
							),
						)}
						{running && (
							<div className="yemu-chat-row assistant">
								<span className="yemu-chat-avatar assistant">
									<Bot size={13} />
								</span>
								<div className="yemu-chat-bubble assistant">
									<span className="yemu-chat-thinking">
										<LoaderCircle size={13} className="spin" />
										正在执行…
									</span>
								</div>
							</div>
						)}
						{question && (
							<div className="yemu-question-card">
								<div className="yemu-question-heading">
									<CircleHelp size={13} />
									<strong>夜雨需要你确认</strong>
								</div>
								<p className="yemu-question-text">
									{typeof question.question === "string"
										? question.question
										: JSON.stringify(question.question)}
								</p>
								{question.options?.length > 0 && (
									<div className="yemu-question-options">
										{question.options.map((option, index) => (
											<button
												type="button"
												key={index}
												className="yemu-question-option"
												onClick={() => submitQuestion(option)}
												disabled={running}
											>
												<span className="yemu-question-option-key">{String.fromCharCode(97 + index)}</span>
												<span>{option}</span>
											</button>
										))}
									</div>
								)}
								<div className="yemu-question-custom">
									<input
										value={questionAnswer}
										onChange={event => setQuestionAnswer(event.target.value)}
										onKeyDown={event => {
											if (event.key === "Enter") submitQuestion(null);
										}}
										placeholder="或直接输入你的回答…"
										disabled={running}
										aria-label="自定义回答"
									/>
									<button
										type="button"
										onClick={() => submitQuestion(null)}
										disabled={running || !questionAnswer.trim()}
									>
										<Send size={13} />
										回答
									</button>
								</div>
							</div>
						)}
					</div>

					<div className="yemu-assistant-composer">
						<div className="yemu-assistant-context-line">
							{chapterFile ? (
								<span>
									<FileText size={11} />
									{chapterTitle || chapterFile}
								</span>
							) : (
								<span>{projectTitle}</span>
							)}
							{toolUsed && (
								<span className="yemu-assistant-usage">
									{usage
										? `${(usage.inputTokens + usage.outputTokens).toLocaleString()} tokens${usage.cost != null ? ` · $${Number(usage.cost).toFixed(4)}` : ""}`
										: "工作区模式"}
								</span>
							)}
						</div>
						{!connected && (
							<div className="yemu-assistant-offline">
								<LoaderCircle size={12} className="spin" />
								正在连接助手…
							</div>
						)}
						<div className="yemu-assistant-input-row">
							<textarea
								ref={inputRef}
								value={input}
								onChange={event => setInput(event.target.value)}
								onKeyDown={event => {
									if (event.key === "Enter" && !event.shiftKey) {
										event.preventDefault();
										send();
									}
								}}
								rows={2}
								disabled={!connected || running}
								placeholder={
									!connected
										? "连接中…"
										: running
											? "夜雨正在执行…"
											: "输入你的需求；Enter 发送，Shift+Enter 换行"
								}
								aria-label="输入消息"
							/>
							{running ? (
								<button
									type="button"
									className="yemu-send stop"
									aria-label="停止"
									title="停止执行"
									onClick={stopTurn}
								>
									<StopCircle size={16} />
								</button>
							) : (
								<button
									type="button"
									className="yemu-send"
									aria-label="发送"
									title="发送 (Enter)"
									disabled={!input.trim() || !connected}
									onClick={send}
								>
									<Send size={16} />
								</button>
							)}
						</div>
						{statusText && <p className="yemu-assistant-status">{statusText}</p>}
					</div>
				</div>
			)}
		</div>
	);
}
