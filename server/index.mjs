// YeMu 叙事工坊 API —— 前端壳 + 文件工作区 + 内嵌 Claude Code CLI 助手
//
// 数据层全部重做为每用户文件工作区（作品/章节=磁盘上的 Markdown 文件，
// CLI 助手直接在文件上工作）；登录、素材库、技能市场、记忆、伏笔沿用
// 原有 JSON / PostgreSQL 存储。

import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { WebSocketServer } from "ws";
import { AssistantBridge } from "./assistant.mjs";
import {
	authSessionConfig,
	createAccessToken,
	createEmailVerificationCode,
	createPasswordResetToken,
	createRefreshSession,
	decryptSecret,
	encryptSecret,
	hashPassword,
	hashPasswordResetToken,
	hashRefreshToken,
	maskKey,
	publicUser,
	refreshCookie,
	usesDefaultSecret,
	verifyAccessToken,
	verifyEmailVerificationCode,
	verifyPassword,
} from "./auth.mjs";
import { refreshCookieOptions } from "./auth-cookie.mjs";
import { emailConfig, sendPasswordResetEmail, sendRegistrationVerificationEmail } from "./email.mjs";
import { isMarketSkillPublished, marketSkillKey } from "./market-skill-runtime.mjs";
import { installSkillPackage } from "./skill-installer.mjs";
import {
	readSkillPackage,
	removeSkillPackage,
	validateSkillPackage,
	writeSkillPackage,
} from "./skill-market-storage.mjs";
import { reviewSkillPackage, skillReviewPublicConfig } from "./skill-review.mjs";
import { closeStore, loadDb, storeInfo, updateDb } from "./store.mjs";
import {
	createChapter,
	createChapterHistory,
	createProject,
	deleteChapter,
	deleteProject,
	ensureUserWorkspace,
	getProject,
	listChapterHistory,
	listChapters,
	listProjects,
	listStoryFiles,
	listUserSkills,
	readChapterDraft,
	readStoryFile,
	removeSkillForUser,
	updateChapter,
	updateProject,
	workspacePathForUser,
	workspaceStats,
	writeChapterDraft,
	writeCliContext,
} from "./workspace.mjs";

const app = express();
const parsedPort = Number(process.env.PORT);
const port = Number.isFinite(parsedPort) ? (parsedPort === 0 ? crypto.randomInt(20_000, 50_000) : parsedPort) : 8787;
const host = process.env.HOST || "127.0.0.1";
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(serverDir, "..", "dist");
const allowedOrigins = (process.env.WEB_ORIGIN || "http://127.0.0.1:5173,http://localhost:5173")
	.split(",")
	.map(origin => origin.trim())
	.filter(Boolean);
const appPublicUrl = (() => {
	const configured = process.env.APP_PUBLIC_URL || allowedOrigins[0] || "http://127.0.0.1:5173";
	let parsed;
	try {
		parsed = new URL(configured);
	} catch {
		throw new Error("APP_PUBLIC_URL must be a valid HTTP or HTTPS URL");
	}
	if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
		throw new Error("APP_PUBLIC_URL must be a public HTTP or HTTPS URL without embedded credentials");
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
})();
const corsMiddleware = cors({ origin: true, credentials: true });
app.use(corsMiddleware);
const PROJECT_TYPES = new Set(["长篇", "短篇", "参考书"]);
const PROJECT_STATUSES = new Set(["构思中", "连载中", "已完结", "已拆文"]);
const CHAPTER_STATES = new Set(["draft", "current", "done"]);
const FORESHADOW_STATUSES = new Set(["planned", "planted", "resolved", "abandoned"]);
const STORY_MEMORY_TYPES = new Set([
	"character_state",
	"event",
	"world_rule",
	"chapter_summary",
	"canon_fact",
	"voice_habit",
]);
const STORY_MEMORY_STATUSES = new Set(["active", "archived"]);
const SKILL_MARKET_CATEGORIES = new Set(["写作", "审稿", "人物", "世界观", "效率", "其他"]);
const registrationMode =
	process.env.REGISTRATION_MODE || (process.env.NODE_ENV === "production" ? "owner-only" : "open");
if (!["open", "owner-only", "closed"].includes(registrationMode)) {
	throw new Error("REGISTRATION_MODE must be open, owner-only, or closed");
}
if (process.env.NODE_ENV === "production" && registrationMode !== "closed" && !emailConfig.configured) {
	throw new Error("Email delivery must be configured when registration is enabled in production");
}
if (process.env.NODE_ENV === "production") {
	if (!process.env.AUTH_SECRET || process.env.AUTH_SECRET.length < 32)
		throw new Error("AUTH_SECRET must contain at least 32 characters in production");
}
const sharedModelApiKey = String(
	process.env.ALLOW_SHARED_MODEL_KEY === "true"
		? process.env.SHARED_MODEL_API_KEY || process.env.ANTHROPIC_API_KEY || ""
		: "",
);

app.use(helmet({ contentSecurityPolicy: false }));
app.use((_req, res, next) => {
	res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
	res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	next();
});
app.use(cookieParser());
app.use(express.json({ limit: "20mb" }));
app.use(
	["/api/auth/register", "/api/auth/login"],
	rateLimit({
		windowMs: 15 * 60 * 1000,
		limit: 20,
		standardHeaders: "draft-8",
		legacyHeaders: false,
		message: { error: "尝试过于频繁，请稍后再试" },
	}),
);
app.use(
	"/api/auth/register/code",
	rateLimit({
		windowMs: 60 * 60 * 1000,
		limit: 10,
		standardHeaders: "draft-8",
		legacyHeaders: false,
		message: { error: "验证码发送过于频繁，请稍后再试" },
	}),
);
app.use(
	["/api/auth/password/forgot", "/api/auth/password/reset"],
	rateLimit({
		windowMs: 60 * 60 * 1000,
		limit: 10,
		standardHeaders: "draft-8",
		legacyHeaders: false,
		message: { error: "操作过于频繁，请稍后再试" },
	}),
);

function cleanText(value, field, maxLength) {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) throw Object.assign(new Error(`${field}不能为空`), { status: 400 });
	if (text.length > maxLength) throw Object.assign(new Error(`${field}不能超过 ${maxLength} 个字符`), { status: 400 });
	return text;
}

function cleanOptionalText(value, field, maxLength) {
	if (value === undefined || value === null) return "";
	const text = String(value).trim();
	if (text.length > maxLength) throw Object.assign(new Error(`${field}不能超过 ${maxLength} 个字符`), { status: 400 });
	return text;
}

function cleanEnum(value, field, allowedValues) {
	const text = String(value ?? "").trim();
	if (!allowedValues.has(text)) throw Object.assign(new Error(`${field}无效`), { status: 400 });
	return text;
}

function cleanIntegerRange(value, field, min, max, fallback = null) {
	if (value === undefined || value === null || value === "") return fallback;
	const number = Number(value);
	if (!Number.isFinite(number)) throw Object.assign(new Error(`${field}必须是数字`), { status: 400 });
	return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanModelBaseUrl(value) {
	if (value === undefined || value === null || value === "") return "";
	const url = String(value).trim();
	if (!url) return "";
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw Object.assign(new Error("Base URL 必须是合法的 http(s) 地址"), { status: 400 });
	}
	if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
		throw Object.assign(new Error("Base URL 必须是合法的 http(s) 地址"), { status: 400 });
	}
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/u, "");
}

function cleanEmail(value) {
	const email = cleanText(value, "邮箱", 254).toLowerCase();
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw Object.assign(new Error("邮箱格式无效"), { status: 400 });
	return email;
}

function cleanPassword(value) {
	const password = typeof value === "string" ? value : "";
	if (password.length < 8) throw Object.assign(new Error("密码至少需要 8 个字符"), { status: 400 });
	if (password.length > 128) throw Object.assign(new Error("密码不能超过 128 个字符"), { status: 400 });
	return password;
}

function cleanTags(value) {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) return [];
	return value
		.map(tag =>
			String(tag)
				.trim()
				.replace(/[\\/:*?"<>|\n]+/g, " ")
				.slice(0, 40),
		)
		.filter(Boolean)
		.slice(0, 12);
}

function unauthorized(message = "请先登录") {
	const error = new Error(message);
	error.status = 401;
	return error;
}

function localDateKey(date = new Date()) {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function cleanStoryMemoryInput(input, { partial = false } = {}) {
	const memory = {};
	if (!partial || input?.type !== undefined) memory.type = cleanEnum(input?.type, "记忆类型", STORY_MEMORY_TYPES);
	if (!partial || input?.title !== undefined) memory.title = cleanText(input?.title, "记忆标题", 160);
	if (!partial || input?.content !== undefined) memory.content = cleanText(input?.content, "记忆内容", 4000);
	if (!partial || input?.status !== undefined)
		memory.status = cleanEnum(input?.status || "active", "记忆状态", STORY_MEMORY_STATUSES);
	if (!partial || input?.importance !== undefined)
		memory.importance = cleanIntegerRange(input?.importance, "记忆重要性", 1, 5, 3);
	if (!partial || input?.characterName !== undefined)
		memory.characterName = cleanOptionalText(input?.characterName, "角色名", 80);
	if (!partial || input?.tags !== undefined) memory.tags = cleanTags(input?.tags);
	return memory;
}

const STORY_MEMORY_ORDER = new Map([
	["character_state", 1],
	["canon_fact", 2],
	["world_rule", 3],
	["event", 4],
	["chapter_summary", 5],
	["voice_habit", 6],
]);

function publicSkillMarketItem(item, userId, author = null, installs = []) {
	const isOwner = item.userId === userId;
	const installed = installs.some(entry => entry.userId === userId && entry.skillId === item.id);
	const review = item.review
		? {
				status: item.review.verdict === "allow" ? "approved" : "rejected",
				reviewer: item.review.reviewer,
				riskLevel: item.review.riskLevel,
				summary: item.review.summary,
				reviewedAt: item.review.reviewedAt,
				...(isOwner ? { findings: item.review.findings || [] } : {}),
			}
		: {
				status: "legacy",
				reviewer: "none",
				riskLevel: "unknown",
				summary: "该 Skill 发布于安全审查功能启用之前。",
				reviewedAt: null,
			};
	return {
		id: item.id,
		name: item.name,
		description: item.description,
		version: item.version,
		category: item.category,
		tags: item.tags || [],
		fileName: item.fileName,
		fileType: item.fileType,
		fileSize: item.fileSize,
		sha256: item.sha256,
		downloads: Math.max(0, Number(item.downloads) || 0),
		author: {
			id: item.userId,
			name: author?.name || item.authorName || "匿名作者",
		},
		isOwner,
		installed,
		installCount: installs.filter(entry => entry.skillId === item.id).length,
		status: item.status,
		isListed: isMarketSkillPublished(item),
		skillKey: marketSkillKey(item.id),
		review,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

function setRefreshCookie(res, token, req) {
	res.cookie(refreshCookie.name, token, refreshCookieOptions(req, { maxAge: refreshCookie.maxAge }));
}

function clearRefreshCookie(res, req) {
	res.clearCookie(refreshCookie.name, refreshCookieOptions(req));
}

async function issueSession(user, req, res) {
	const accessToken = await createAccessToken(user);
	const refresh = createRefreshSession(user.id, { userAgent: req.get("user-agent") });
	await updateDb(db => {
		db.sessions = db.sessions.filter(session => new Date(session.expiresAt) > new Date());
		db.sessions.push(refresh.session);
	});
	setRefreshCookie(res, refresh.token, req);
	return { accessToken, user: publicUser(user) };
}

async function authenticate(req, _res, next) {
	try {
		const authorization = req.get("authorization") || "";
		const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
		if (!token) throw unauthorized();
		const user = await verifyAccessToken(token);
		if (!user) throw unauthorized();
		req.user = { ...user, id: user.sub };
		next();
	} catch (error) {
		next(error);
	}
}

async function workspaceOf(req) {
	await ensureUserWorkspace(req.user.id);
	return req.user.id;
}

async function resolveCliEnv(userId) {
	const db = await loadDb();
	const settings = db.settings?.[userId] || {};
	const apiKey = settings.apiKeyEnc ? decryptSecret(settings.apiKeyEnc) : sharedModelApiKey;
	return {
		ANTHROPIC_API_KEY: apiKey,
		ANTHROPIC_BASE_URL: settings.apiBaseUrl || process.env.ANTHROPIC_BASE_URL || "",
		ANTHROPIC_MODEL: settings.model || process.env.ANTHROPIC_MODEL || "",
	};
}

const assistantBridge = new AssistantBridge({ resolveUserEnv: resolveCliEnv });

async function projectOf(userId, projectId) {
	const project = await getProject(userId, projectId);
	if (!project) throw Object.assign(new Error("作品不存在"), { status: 404 });
	return project;
}

app.get("/api/health", async (_req, res, next) => {
	try {
		const db = await loadDb();
		res.json({
			ok: true,
			users: db.users.length,
			storage: storeInfo(),
			skillReview: skillReviewPublicConfig(),
			email: emailConfig,
			authSession: {
				accessMinutes: authSessionConfig.accessTtlSeconds / 60,
				refreshDays: authSessionConfig.refreshTtlMs / (24 * 60 * 60 * 1000),
			},
		});
	} catch (error) {
		next(error);
	}
});

const registrationCodeResponseMessage = "如果该邮箱可以注册，我们会发送一封验证码邮件，请检查收件箱和垃圾邮件。";

app.post("/api/auth/register/code", async (req, res, next) => {
	try {
		const email = cleanEmail(req.body?.email);
		const verificationRequest = await updateDb(db => {
			if (registrationMode === "closed" || (registrationMode === "owner-only" && db.users.length > 0)) {
				throw Object.assign(new Error("当前站点未开放注册"), { status: 403 });
			}
			const now = Date.now();
			db.emailVerificationCodes = db.emailVerificationCodes.filter(
				item => new Date(item.expiresAt).getTime() > now && Number(item.attempts || 0) < 5,
			);
			if (db.users.some(item => item.email === email)) return null;
			const existing = db.emailVerificationCodes.find(item => item.email === email);
			if (existing && now - new Date(existing.createdAt).getTime() < 60_000) return { cooldown: true };
			const verification = createEmailVerificationCode(email);
			db.emailVerificationCodes = db.emailVerificationCodes.filter(item => item.email !== email);
			db.emailVerificationCodes.push(verification.record);
			return verification;
		});

		if (verificationRequest?.record) {
			try {
				const delivery = await sendRegistrationVerificationEmail({
					to: email,
					code: verificationRequest.code,
					expiresInMinutes: authSessionConfig.emailVerificationTtlMs / (60 * 1000),
					idempotencyKey: verificationRequest.record.id,
				});
				if (!delivery.delivered) {
					await updateDb(db => {
						db.emailVerificationCodes = db.emailVerificationCodes.filter(
							item => item.id !== verificationRequest.record.id,
						);
					});
				}
			} catch (error) {
				await updateDb(db => {
					db.emailVerificationCodes = db.emailVerificationCodes.filter(
						item => item.id !== verificationRequest.record.id,
					);
				}).catch(() => undefined);
				console.error(`Registration verification email delivery failed: ${error.message}`);
			}
		}

		const payload = { message: registrationCodeResponseMessage, retryAfterSeconds: 60 };
		if (
			process.env.NODE_ENV === "test" &&
			process.env.EMAIL_VERIFICATION_EXPOSE_CODE === "true" &&
			verificationRequest?.code
		) {
			payload.verificationCode = verificationRequest.code;
		}
		res.status(202).json(payload);
	} catch (error) {
		next(error);
	}
});

app.post("/api/auth/register", async (req, res, next) => {
	try {
		const name = cleanText(req.body?.name, "昵称", 40);
		const email = cleanEmail(req.body?.email);
		const password = cleanPassword(req.body?.password);
		const verificationCode = typeof req.body?.verificationCode === "string" ? req.body.verificationCode.trim() : "";
		if (!/^\d{6}$/.test(verificationCode)) {
			throw Object.assign(new Error("请输入 6 位邮箱验证码"), { status: 400 });
		}
		const passwordHash = await hashPassword(password);
		const user = {
			id: crypto.randomUUID(),
			name,
			email,
			passwordHash,
			authVersion: 0,
			createdAt: new Date().toISOString(),
		};
		const result = await updateDb(db => {
			if (registrationMode === "closed" || (registrationMode === "owner-only" && db.users.length > 0)) {
				throw Object.assign(new Error("当前站点未开放注册"), { status: 403 });
			}
			if (db.users.some(item => item.email === email)) {
				throw Object.assign(new Error("该邮箱已经注册"), { status: 409 });
			}
			const now = Date.now();
			const verification = db.emailVerificationCodes.find(
				item => item.email === email && new Date(item.expiresAt).getTime() > now && Number(item.attempts || 0) < 5,
			);
			if (!verification || !verifyEmailVerificationCode(email, verificationCode, verification.codeHash)) {
				if (verification) {
					verification.attempts = Number(verification.attempts || 0) + 1;
					if (verification.attempts >= 5)
						db.emailVerificationCodes = db.emailVerificationCodes.filter(item => item.id !== verification.id);
				} else {
					db.emailVerificationCodes = db.emailVerificationCodes.filter(item => item.email !== email);
				}
				return { error: "邮箱验证码无效或已过期，请重新获取" };
			}
			db.emailVerificationCodes = db.emailVerificationCodes.filter(item => item.email !== email);
			db.users.push(user);
			return { user };
		});
		if (result.error) throw Object.assign(new Error(result.error), { status: 400 });
		const created = result.user;
		await ensureUserWorkspace(created.id);
		res.status(201).json(await issueSession(created, req, res));
	} catch (error) {
		next(error);
	}
});

app.post("/api/auth/login", async (req, res, next) => {
	try {
		const email = cleanEmail(req.body?.email);
		const password = cleanPassword(req.body?.password);
		const db = await loadDb();
		const user = db.users.find(item => item.email === email);
		if (!user || !(await verifyPassword(password, user.passwordHash))) throw unauthorized("邮箱或密码不正确");
		res.json(await issueSession(user, req, res));
	} catch (error) {
		next(error);
	}
});

const passwordResetResponseMessage = "如果该邮箱已注册，我们会发送一封密码重置邮件，请检查收件箱和垃圾邮件。";

app.post("/api/auth/password/forgot", async (req, res, next) => {
	try {
		const email = cleanEmail(req.body?.email);
		const resetRequest = await updateDb(db => {
			const now = Date.now();
			db.passwordResetTokens = db.passwordResetTokens.filter(item => new Date(item.expiresAt).getTime() > now);
			const user = db.users.find(item => item.email === email);
			if (!user) return null;
			const reset = createPasswordResetToken(user.id);
			db.passwordResetTokens = db.passwordResetTokens.filter(item => item.userId !== user.id);
			db.passwordResetTokens.push(reset.record);
			return { user: publicUser(user), ...reset };
		});

		if (resetRequest) {
			const resetUrl = new URL(appPublicUrl);
			resetUrl.searchParams.set("reset_token", resetRequest.token);
			try {
				await sendPasswordResetEmail({
					to: resetRequest.user.email,
					name: resetRequest.user.name,
					resetUrl: resetUrl.toString(),
					expiresInMinutes: authSessionConfig.passwordResetTtlMs / (60 * 1000),
					idempotencyKey: resetRequest.record.id,
				});
			} catch (error) {
				console.error(`Password reset email delivery failed: ${error.message}`);
			}
		}

		const payload = { message: passwordResetResponseMessage };
		if (process.env.NODE_ENV === "test" && process.env.PASSWORD_RESET_EXPOSE_TOKEN === "true" && resetRequest) {
			payload.resetToken = resetRequest.token;
		}
		res.status(202).json(payload);
	} catch (error) {
		next(error);
	}
});

app.post("/api/auth/password/reset", async (req, res, next) => {
	try {
		const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
		if (token.length < 32 || token.length > 200) {
			throw Object.assign(new Error("重置链接无效或已过期，请重新申请"), { status: 400 });
		}
		const password = cleanPassword(req.body?.password);
		const passwordHash = await hashPassword(password);
		const tokenHash = hashPasswordResetToken(token);
		await updateDb(db => {
			const now = Date.now();
			const reset = db.passwordResetTokens.find(
				item => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > now,
			);
			const user = reset && db.users.find(item => item.id === reset.userId);
			if (!reset || !user) {
				db.passwordResetTokens = db.passwordResetTokens.filter(item => new Date(item.expiresAt).getTime() > now);
				throw Object.assign(new Error("重置链接无效或已过期，请重新申请"), { status: 400 });
			}
			user.passwordHash = passwordHash;
			user.authVersion = (Number(user.authVersion) || 0) + 1;
			db.sessions = db.sessions.filter(session => session.userId !== user.id);
			db.passwordResetTokens = db.passwordResetTokens.filter(item => item.userId !== user.id);
		});
		clearRefreshCookie(res, req);
		res.json({ message: "密码已更新，请使用新密码登录。" });
	} catch (error) {
		next(error);
	}
});

app.post("/api/auth/refresh", async (req, res, next) => {
	try {
		const rawToken = req.cookies[refreshCookie.name];
		if (!rawToken) throw unauthorized();
		const tokenHash = hashRefreshToken(rawToken);
		const result = await updateDb(db => {
			const index = db.sessions.findIndex(
				session => session.tokenHash === tokenHash && new Date(session.expiresAt) > new Date(),
			);
			if (index === -1) throw unauthorized("登录已过期，请重新登录");
			const session = db.sessions[index];
			const user = db.users.find(item => item.id === session.userId);
			if (!user) throw unauthorized("账号不存在");
			db.sessions.splice(index, 1);
			const nextSession = createRefreshSession(user.id, { userAgent: req.get("user-agent") });
			db.sessions.push(nextSession.session);
			return { user, token: nextSession.token };
		});
		setRefreshCookie(res, result.token, req);
		res.json({ accessToken: await createAccessToken(result.user), user: publicUser(result.user) });
	} catch (error) {
		clearRefreshCookie(res, req);
		next(error);
	}
});

app.post("/api/auth/logout", async (req, res, next) => {
	try {
		const rawToken = req.cookies[refreshCookie.name];
		if (rawToken) {
			const tokenHash = hashRefreshToken(rawToken);
			await updateDb(db => {
				db.sessions = db.sessions.filter(session => session.tokenHash !== tokenHash);
			});
		}
		clearRefreshCookie(res, req);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/auth/me", authenticate, (req, res) => {
	res.json({ user: publicUser(req.user) });
});

app.use("/api", authenticate);

function sanitizeSettings(input, existing) {
	const settings = { ...(existing || {}) };
	if (input.apiBaseUrl !== undefined) {
		settings.apiBaseUrl = cleanModelBaseUrl(input.apiBaseUrl);
	}
	if (input.provider !== undefined) {
		settings.provider = input.provider === "anthropic" ? "anthropic" : "openai";
	}
	if (input.model !== undefined) {
		settings.model = typeof input.model === "string" ? input.model.trim().slice(0, 80) : "";
	}
	if (input.apiKey !== undefined && input.apiKey !== null && String(input.apiKey).trim()) {
		settings.apiKeyEnc = encryptSecret(String(input.apiKey).trim());
	}
	return settings;
}

function publicSettings(settings) {
	if (!settings) {
		return { provider: "openai", apiBaseUrl: "", model: "", apiKeyMask: null };
	}
	return {
		provider: settings.provider === "anthropic" ? "anthropic" : "openai",
		apiBaseUrl: settings.apiBaseUrl || "",
		apiKeyMask: maskKey(decryptSecret(settings.apiKeyEnc)),
		model: settings.model || "",
	};
}

app.get("/api/settings", async (req, res, next) => {
	try {
		const db = await loadDb();
		const settings = db.settings?.[req.user.id];
		res.json({ settings: publicSettings(settings) });
	} catch (error) {
		next(error);
	}
});

app.put("/api/settings", async (req, res, next) => {
	try {
		const settings = await updateDb(db => {
			db.settings ||= {};
			db.settings[req.user.id] = sanitizeSettings(req.body, db.settings[req.user.id]);
			return db.settings[req.user.id];
		});
		res.json({ settings: publicSettings(settings) });
	} catch (error) {
		next(error);
	}
});

app.get("/api/skill-market", async (req, res, next) => {
	try {
		const query = String(req.query.q || "")
			.trim()
			.toLowerCase()
			.slice(0, 120);
		const category = String(req.query.category || "").trim();
		const mineOnly = req.query.mine === "true";
		const db = await loadDb();
		const users = new Map(db.users.map(user => [user.id, user]));
		const items = (db.skillMarketItems || [])
			.filter(item => isMarketSkillPublished(item) || item.userId === req.user.id)
			.filter(item => !mineOnly || item.userId === req.user.id)
			.filter(item => !category || item.category === category)
			.filter(
				item =>
					!query ||
					[item.name, item.description, item.category, ...(item.tags || []), users.get(item.userId)?.name]
						.filter(Boolean)
						.join(" ")
						.toLowerCase()
						.includes(query),
			)
			.sort(
				(left, right) =>
					Number(right.downloads || 0) - Number(left.downloads || 0) ||
					String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
			)
			.map(item => publicSkillMarketItem(item, req.user.id, users.get(item.userId), db.skillMarketInstalls || []));
		res.json({ items, categories: [...SKILL_MARKET_CATEGORIES], review: skillReviewPublicConfig() });
	} catch (error) {
		next(error);
	}
});

const skillUploadRateLimit = rateLimit({
	windowMs: 60 * 60 * 1000,
	limit: 30,
	standardHeaders: "draft-8",
	legacyHeaders: false,
	message: { error: "Skill 上传和审查过于频繁，请稍后再试" },
});

app.post("/api/skill-market", skillUploadRateLimit, async (req, res, next) => {
	let storageName = "";
	try {
		const name = cleanText(req.body?.name, "Skill 名称", 80);
		const description = cleanText(req.body?.description, "Skill 简介", 500);
		const version = cleanOptionalText(req.body?.version, "版本号", 32) || "1.0.0";
		const category = cleanEnum(req.body?.category || "其他", "分类", SKILL_MARKET_CATEGORIES);
		const tags = cleanTags(req.body?.tags);
		const rawFileName = path.basename(cleanText(req.body?.fileName, "文件名", 180));
		const fileName = rawFileName.replace(/[^\p{L}\p{N}._()（）\-\s]/gu, "_");
		if (!fileName || fileName === "." || fileName === "..")
			throw Object.assign(new Error("文件名无效"), { status: 400 });
		const existing = await loadDb();
		const duplicate = (existing.skillMarketItems || []).find(
			entry =>
				entry.userId === req.user.id &&
				entry.name.toLowerCase() === name.toLowerCase() &&
				entry.version === version,
		);
		if (duplicate) throw Object.assign(new Error("同名同版本 Skill 已经发布"), { status: 409 });
		const validated = validateSkillPackage({ fileName, contentBase64: req.body?.contentBase64 });
		const review = await reviewSkillPackage({
			name,
			description,
			version,
			category,
			tags,
			fileName,
			extension: validated.extension,
			buffer: validated.buffer,
			sha256: validated.sha256,
		});
		if (review.verdict !== "allow") {
			const primaryFinding = review.findings?.[0]?.title;
			throw Object.assign(
				new Error(
					primaryFinding ? `Skill 未通过安全审查：${primaryFinding}` : `Skill 未通过安全审查：${review.summary}`,
				),
				{ status: 422 },
			);
		}
		const id = crypto.randomUUID();
		storageName = await writeSkillPackage(id, validated.extension, validated.buffer);
		const timestamp = new Date().toISOString();
		const item = {
			id,
			userId: req.user.id,
			authorName: req.user.name,
			name,
			description,
			version,
			category,
			tags,
			fileName,
			fileType: validated.contentType,
			fileSize: validated.size,
			sha256: validated.sha256,
			storageName,
			downloads: 0,
			status: review.reviewer === "model" ? "published" : "pending_review",
			review,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await updateDb(db => {
			db.skillMarketItems ||= [];
			const duplicate = db.skillMarketItems.find(
				entry =>
					entry.userId === req.user.id &&
					entry.name.toLowerCase() === name.toLowerCase() &&
					entry.version === version,
			);
			if (duplicate) throw Object.assign(new Error("同名同版本 Skill 已经发布"), { status: 409 });
			db.skillMarketItems.unshift(item);
		});
		res.status(201).json({ item: publicSkillMarketItem(item, req.user.id, req.user, []) });
	} catch (error) {
		if (storageName) await removeSkillPackage(storageName).catch(() => undefined);
		next(error);
	}
});

app.get("/api/skill-market/:skillId/download", async (req, res, next) => {
	try {
		const db = await loadDb();
		const item = (db.skillMarketItems || []).find(
			entry => entry.id === req.params.skillId && isMarketSkillPublished(entry),
		);
		if (!item) throw Object.assign(new Error("Skill 不存在或已下架"), { status: 404 });
		const buffer = await readSkillPackage(item.storageName);
		await updateDb(current => {
			const target = (current.skillMarketItems || []).find(
				entry => entry.id === item.id && isMarketSkillPublished(entry),
			);
			if (target) {
				target.downloads = Math.max(0, Number(target.downloads) || 0) + 1;
				target.updatedAt = new Date().toISOString();
			}
		});
		res.set({
			"Content-Type": item.fileType || "application/octet-stream",
			"Content-Length": String(buffer.length),
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		});
		res.attachment(item.fileName);
		res.send(buffer);
	} catch (error) {
		next(error);
	}
});

app.post("/api/skill-market/:skillId/review", skillUploadRateLimit, async (req, res, next) => {
	try {
		const db = await loadDb();
		const item = (db.skillMarketItems || []).find(entry => entry.id === req.params.skillId);
		if (!item) throw Object.assign(new Error("Skill 不存在"), { status: 404 });
		if (item.userId !== req.user.id) throw Object.assign(new Error("只能重新审查自己上传的 Skill"), { status: 403 });
		const buffer = await readSkillPackage(item.storageName);
		const validated = validateSkillPackage({ fileName: item.fileName, contentBase64: buffer.toString("base64") });
		if (validated.sha256 !== item.sha256) throw Object.assign(new Error("Skill 文件完整性校验失败"), { status: 409 });
		const review = await reviewSkillPackage({
			name: item.name,
			description: item.description,
			version: item.version,
			category: item.category,
			tags: item.tags,
			fileName: item.fileName,
			extension: validated.extension,
			buffer: validated.buffer,
			sha256: validated.sha256,
		});
		const updated = await updateDb(current => {
			const target = (current.skillMarketItems || []).find(
				entry => entry.id === item.id && entry.userId === req.user.id,
			);
			if (!target) throw Object.assign(new Error("Skill 不存在"), { status: 404 });
			target.review = review;
			target.status = review.verdict === "allow" && review.reviewer === "model" ? "published" : "pending_review";
			target.updatedAt = new Date().toISOString();
			return target;
		});
		if (!isMarketSkillPublished(updated)) {
			throw Object.assign(
				new Error(
					review.verdict === "reject"
						? `Skill 未通过安全审查：${review.findings?.[0]?.title || review.summary}`
						: "专用模型审查尚未完成，Skill 仍处于待审查状态",
				),
				{ status: 422 },
			);
		}
		const latest = await loadDb();
		res.json({ item: publicSkillMarketItem(updated, req.user.id, req.user, latest.skillMarketInstalls || []) });
	} catch (error) {
		next(error);
	}
});

app.post("/api/skill-market/:skillId/install", async (req, res, next) => {
	try {
		const db = await loadDb();
		const item = (db.skillMarketItems || []).find(entry => entry.id === req.params.skillId);
		if (!isMarketSkillPublished(item)) throw Object.assign(new Error("该 Skill 尚未通过审查并上架"), { status: 404 });
		const extracted = await readSkillPackage(item.storageName).then(buffer => {
			const unzip = validateSkillPackage({ fileName: item.fileName, contentBase64: buffer.toString("base64") });
			return { extension: unzip.extension, buffer: unzip.buffer };
		});
		if (extracted.extension !== ".zip")
			throw Object.assign(new Error("该 Skill 不是可安装的归档包"), { status: 400 });
		const workspaceSkillsDir = path.join(workspacePathForUser(req.user.id), ".claude", "skills");
		await installSkillPackage(workspaceSkillsDir, extracted.buffer, item.name);
		await updateDb(current => {
			current.skillMarketInstalls ||= [];
			const exists = current.skillMarketInstalls.some(
				entry => entry.userId === req.user.id && entry.skillId === item.id,
			);
			if (!exists)
				current.skillMarketInstalls.push({
					userId: req.user.id,
					skillId: item.id,
					installedAt: new Date().toISOString(),
				});
		});
		const latest = await loadDb();
		const author = latest.users.find(user => user.id === item.userId);
		res.json({ item: publicSkillMarketItem(item, req.user.id, author, latest.skillMarketInstalls || []) });
	} catch (error) {
		next(error);
	}
});

app.delete("/api/skill-market/:skillId/install", async (req, res, next) => {
	try {
		const db = await loadDb();
		const item = (db.skillMarketItems || []).find(entry => entry.id === req.params.skillId);
		if (item) await removeSkillForUser(req.user.id, item.name);
		await updateDb(current => {
			current.skillMarketInstalls ||= [];
			current.skillMarketInstalls = current.skillMarketInstalls.filter(
				entry => !(entry.userId === req.user.id && entry.skillId === req.params.skillId),
			);
		});
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.delete("/api/skill-market/:skillId", async (req, res, next) => {
	try {
		const removed = await updateDb(db => {
			const item = (db.skillMarketItems || []).find(entry => entry.id === req.params.skillId);
			if (!item) throw Object.assign(new Error("Skill 不存在"), { status: 404 });
			if (item.userId !== req.user.id) throw Object.assign(new Error("只能下架自己上传的 Skill"), { status: 403 });
			db.skillMarketItems = db.skillMarketItems.filter(entry => entry.id !== item.id);
			db.skillMarketInstalls = (db.skillMarketInstalls || []).filter(entry => entry.skillId !== item.id);
			return item;
		});
		await removeSkillPackage(removed.storageName);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/skills", async (req, res, next) => {
	try {
		const names = await listUserSkills(req.user.id);
		const db = await loadDb();
		const marketItems = new Map((db.skillMarketItems || []).map(item => [item.name.toLowerCase(), item]));
		res.json({
			skills: names.map(name => {
				const marketItem = marketItems.get(name.toLowerCase());
				return {
					name,
					status: "ready",
					version: marketItem?.version || "workspace",
					description: marketItem?.description || "已安装到工作区的 Skill",
					route: "cli",
				};
			}),
		});
	} catch (error) {
		next(error);
	}
});

const STATIC_MODEL_LIST = ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "opus", "sonnet", "haiku"];

app.post("/api/ai/models", async (_req, res, next) => {
	try {
		res.json({ models: STATIC_MODEL_LIST });
	} catch (error) {
		next(error);
	}
});

app.get("/api/assistant/status", async (req, res, next) => {
	try {
		const projectId = req.query.project ? String(req.query.project) : "";
		res.json({
			session: projectId
				? assistantBridge.status(req.user.id, projectId)
				: { running: false, sessionId: null, clients: 0 },
		});
	} catch (error) {
		next(error);
	}
});

app.get("/api/assistant/sessions", async (req, res, next) => {
	try {
		const projectId = req.query.project ? String(req.query.project) : "";
		if (!projectId) throw Object.assign(new Error("缺少作品 ID"), { status: 400 });
		await projectOf(req.user.id, projectId);
		res.json({ sessions: await assistantBridge.listSessions(req.user.id, projectId) });
	} catch (error) {
		next(error);
	}
});

app.get("/api/projects", async (req, res, next) => {
	try {
		res.json({ projects: await listProjects(req.user.id) });
	} catch (error) {
		next(error);
	}
});

app.get("/api/dashboard", async (req, res, next) => {
	try {
		const stats = await workspaceStats(req.user.id);
		const db = await loadDb();
		const ideas = db.ideas.filter(idea => idea.userId === req.user.id);
		const log = db.writingLog.filter(entry => entry.userId === req.user.id);
		const wordsByDate = new Map();
		for (const entry of log) {
			wordsByDate.set(entry.date, (wordsByDate.get(entry.date) || 0) + Number(entry.words || 0));
		}
		const now = new Date();
		const daily = [];
		for (let offset = 6; offset >= 0; offset -= 1) {
			const date = new Date(now);
			date.setHours(0, 0, 0, 0);
			date.setDate(date.getDate() - offset);
			const key = localDateKey(date);
			daily.push({ date: key, words: wordsByDate.get(key) || 0 });
		}
		let previousWeekWords = 0;
		for (let offset = 13; offset >= 7; offset -= 1) {
			const date = new Date(now);
			date.setHours(0, 0, 0, 0);
			date.setDate(date.getDate() - offset);
			const key = localDateKey(date);
			previousWeekWords += wordsByDate.get(key) || 0;
		}
		const weekWords = daily.reduce((total, item) => total + item.words, 0);
		const calendar = [];
		for (let offset = 364; offset >= 0; offset -= 1) {
			const date = new Date(now);
			date.setHours(0, 0, 0, 0);
			date.setDate(date.getDate() - offset);
			const key = localDateKey(date);
			calendar.push({ date: key, words: wordsByDate.get(key) || 0 });
		}
		const activeDateKeys = [...wordsByDate.entries()]
			.filter(([, words]) => words > 0)
			.map(([date]) => date)
			.sort();
		const activeDateSet = new Set(activeDateKeys);
		const todayKey = localDateKey(now);
		const streakCursor = new Date(now);
		streakCursor.setHours(0, 0, 0, 0);
		if (!activeDateSet.has(todayKey)) streakCursor.setDate(streakCursor.getDate() - 1);
		let currentStreak = 0;
		while (activeDateSet.has(localDateKey(streakCursor))) {
			currentStreak += 1;
			streakCursor.setDate(streakCursor.getDate() - 1);
		}
		let longestStreak = 0;
		let runningStreak = 0;
		let previousActiveDate = null;
		for (const key of activeDateKeys) {
			const date = new Date(`${key}T00:00:00`);
			const followsPrevious =
				previousActiveDate && Math.round((date.getTime() - previousActiveDate.getTime()) / 86_400_000) === 1;
			runningStreak = followsPrevious ? runningStreak + 1 : 1;
			longestStreak = Math.max(longestStreak, runningStreak);
			previousActiveDate = date;
		}
		const monthKey = todayKey.slice(0, 7);
		const monthWords = [...wordsByDate.entries()]
			.filter(([date]) => date.startsWith(monthKey))
			.reduce((total, [, words]) => total + words, 0);
		const totalWritingDays = activeDateKeys.length;
		res.json({
			stats: {
				projectCount: stats.projectCount,
				completedProjects: stats.projects.filter(project => project.status === "已完结").length,
				chapterCount: stats.chapterCount,
				totalWords: stats.totalWords,
				todayWords: daily.at(-1)?.words || 0,
				weekWords,
				previousWeekWords,
				growthPercent:
					previousWeekWords > 0 ? Math.round(((weekWords - previousWeekWords) / previousWeekWords) * 100) : null,
				activeDays: daily.filter(item => item.words > 0).length,
				totalWritingDays,
				currentStreak,
				longestStreak,
				monthWords,
				averageWordsPerWritingDay: totalWritingDays
					? Math.round([...wordsByDate.values()].reduce((total, words) => total + words, 0) / totalWritingDays)
					: 0,
				maxDailyWords: Math.max(0, ...wordsByDate.values()),
				firstWritingDate: activeDateKeys[0] || null,
				daily,
				calendar,
				ideasCount: ideas.length,
			},
		});
	} catch (error) {
		next(error);
	}
});

app.get("/api/projects/:projectId", async (req, res, next) => {
	try {
		res.json({ project: await projectOf(req.user.id, req.params.projectId) });
	} catch (error) {
		next(error);
	}
});

app.post("/api/projects", async (req, res, next) => {
	try {
		const type = cleanEnum(req.body?.type || "长篇", "作品类型", PROJECT_TYPES);
		const genre = cleanText(req.body?.genre || "现代言情", "题材", 40);
		const result = await createProject(await workspaceOf(req), {
			title: req.body?.title,
			type,
			genre,
			style: cleanOptionalText(req.body?.style, "风格", 80),
			premise: cleanOptionalText(req.body?.premise, "主线", 4000),
		});
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

app.post("/api/projects/import", async (req, res, next) => {
	try {
		const title = cleanText(req.body?.title, "作品标题", 120);
		const type = cleanEnum(req.body?.type || "长篇", "作品类型", PROJECT_TYPES);
		const chapters = Array.isArray(req.body?.chapters) ? req.body.chapters.slice(0, 500) : [];
		if (!chapters.length) throw Object.assign(new Error("导入文稿至少需要一个章节"), { status: 400 });
		const result = await createProject(await workspaceOf(req), {
			title,
			type,
			genre: cleanOptionalText(req.body?.genre, "题材", 40) || "现代言情",
			style: cleanOptionalText(req.body?.style, "风格", 80),
		});
		for (const chapter of chapters) {
			const titleText =
				typeof chapter?.title === "string" && chapter.title.trim() ? chapter.title.trim() : "未命名章节";
			await writeChapterDraft(req.user.id, result.project.id, result.chapter.id, String(chapter?.content ?? ""));
			await updateChapter(req.user.id, result.project.id, result.chapter.id, { title: titleText });
			await createChapter(req.user.id, result.project.id, "");
		}
		const project = await getProject(req.user.id, result.project.id);
		const chapterList = await listChapters(req.user.id, result.project.id);
		res.status(201).json({ project, chapters: chapterList });
	} catch (error) {
		next(error);
	}
});

app.patch("/api/projects/:projectId", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const updates = {};
		if (req.body.title !== undefined) updates.title = cleanText(req.body.title, "作品标题", 120);
		if (req.body.type !== undefined) updates.type = cleanEnum(req.body.type, "作品类型", PROJECT_TYPES);
		if (req.body.genre !== undefined) updates.genre = cleanText(req.body.genre, "题材", 40);
		if (req.body.style !== undefined) updates.style = cleanOptionalText(req.body.style, "风格", 80);
		if (req.body.premise !== undefined) updates.premise = cleanOptionalText(req.body.premise, "主线", 4000);
		if (req.body.status !== undefined) updates.status = cleanEnum(req.body.status, "作品状态", PROJECT_STATUSES);
		if (req.body.isActive !== undefined) updates.isActive = req.body.isActive === true;
		const project = await updateProject(req.user.id, req.params.projectId, updates);
		res.json({ project });
	} catch (error) {
		next(error);
	}
});

app.delete("/api/projects/:projectId", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		await deleteProject(req.user.id, req.params.projectId);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/projects/:projectId/chapters", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		res.json({ chapters: await listChapters(req.user.id, req.params.projectId) });
	} catch (error) {
		next(error);
	}
});

app.post("/api/projects/:projectId/chapters", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const title = cleanOptionalText(req.body?.title, "章节标题", 60);
		const result = await createChapter(req.user.id, req.params.projectId, title);
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

app.patch("/api/projects/:projectId/chapters/:chapterId", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const updates = {};
		if (req.body.title !== undefined) updates.title = cleanText(req.body.title, "章节标题", 60);
		if (req.body.state !== undefined) updates.state = cleanEnum(req.body.state, "章节状态", CHAPTER_STATES);
		const result = await updateChapter(req.user.id, req.params.projectId, req.params.chapterId, updates);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

app.delete("/api/projects/:projectId/chapters/:chapterId", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		await deleteChapter(req.user.id, req.params.projectId, req.params.chapterId);
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/projects/:projectId/chapters/:chapterId/draft", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const content = await readChapterDraft(req.user.id, req.params.projectId, req.params.chapterId);
		res.json({ content });
	} catch (error) {
		next(error);
	}
});

app.put("/api/projects/:projectId/chapters/:chapterId/draft", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const content = typeof req.body?.content === "string" ? req.body.content.slice(0, 2_000_000) : "";
		const result = await writeChapterDraft(req.user.id, req.params.projectId, req.params.chapterId, content);
		res.json(result);
	} catch (error) {
		next(error);
	}
});

app.get("/api/projects/:projectId/chapters/:chapterId/history", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		res.json({ snapshots: await listChapterHistory(req.user.id, req.params.projectId, req.params.chapterId) });
	} catch (error) {
		next(error);
	}
});

app.post("/api/projects/:projectId/chapters/:chapterId/history", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const content = typeof req.body?.content === "string" ? req.body.content.slice(0, 2_000_000) : "";
		const snapshot = await createChapterHistory(req.user.id, req.params.projectId, req.params.chapterId, content);
		res.status(201).json({ snapshot });
	} catch (error) {
		next(error);
	}
});

app.get("/api/projects/:projectId/files", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		res.json({ files: await listStoryFiles(req.user.id, req.params.projectId) });
	} catch (error) {
		next(error);
	}
});

app.get("/api/projects/:projectId/files/:name", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const content = await readStoryFile(req.user.id, req.params.projectId, req.params.name);
		res.json({ content });
	} catch (error) {
		next(error);
	}
});

app.post("/api/projects/:projectId/cli-context", async (req, res, next) => {
	try {
		await projectOf(req.user.id, req.params.projectId);
		const db = await loadDb();
		await writeCliContext(req.user.id, req.params.projectId, {
			memories: db.storyMemories.filter(
				item => item.userId === req.user.id && item.projectId === req.params.projectId,
			),
			foreshadows: db.foreshadows.filter(
				item => item.userId === req.user.id && item.projectId === req.params.projectId,
			),
		});
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/story-memories", async (req, res, next) => {
	try {
		const db = await loadDb();
		const projectId = req.query.projectId ? String(req.query.projectId) : "";
		if (projectId) await projectOf(req.user.id, projectId);
		const memories = db.storyMemories
			.filter(item => item.userId === req.user.id && (!projectId || item.projectId === projectId))
			.sort(
				(left, right) =>
					(STORY_MEMORY_ORDER.get(left.type) ?? 99) - (STORY_MEMORY_ORDER.get(right.type) ?? 99) ||
					Number(right.importance || 0) - Number(left.importance || 0) ||
					String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
			);
		res.json({ memories });
	} catch (error) {
		next(error);
	}
});

app.post("/api/story-memories", async (req, res, next) => {
	try {
		const memory = await updateDb(db => {
			const projectId = cleanOptionalText(req.body?.projectId, "作品 ID", 80);
			const created = {
				id: crypto.randomUUID(),
				userId: req.user.id,
				projectId,
				...cleanStoryMemoryInput(req.body),
				sourceChapterId:
					req.body?.sourceChapterId == null || req.body?.sourceChapterId === ""
						? null
						: String(req.body.sourceChapterId),
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			db.storyMemories = [created, ...db.storyMemories];
			return created;
		});
		res.status(201).json({ memory });
	} catch (error) {
		next(error);
	}
});

app.post("/api/story-memories/batch", async (req, res, next) => {
	try {
		if (!Array.isArray(req.body?.memories) || !req.body.memories.length)
			throw Object.assign(new Error("至少需要一条候选记忆"), { status: 400 });
		if (req.body.memories.length > 40) throw Object.assign(new Error("单次最多确认 40 条记忆"), { status: 400 });
		const result = await updateDb(db => {
			const projectId = cleanOptionalText(req.body?.projectId, "作品 ID", 80);
			const created = [];
			const updated = [];
			const timestamp = new Date().toISOString();
			for (const input of req.body.memories) {
				const replacingId = input?.replacesMemoryId || input?.replaces_memory_id;
				const existing = replacingId
					? db.storyMemories.find(
							item => item.id === replacingId && item.userId === req.user.id && item.projectId === projectId,
						)
					: null;
				if (existing) {
					Object.assign(existing, cleanStoryMemoryInput(input), {
						sourceChapterId:
							input?.sourceChapterId == null || input?.sourceChapterId === ""
								? existing.sourceChapterId
								: String(input.sourceChapterId),
						updatedAt: timestamp,
					});
					updated.push(existing);
				} else {
					const memory = {
						id: crypto.randomUUID(),
						userId: req.user.id,
						projectId,
						...cleanStoryMemoryInput(input),
						sourceChapterId:
							input?.sourceChapterId == null || input?.sourceChapterId === ""
								? null
								: String(input.sourceChapterId),
						createdAt: timestamp,
						updatedAt: timestamp,
					};
					db.storyMemories.unshift(memory);
					created.push(memory);
				}
			}
			return { created, updated };
		});
		res.status(201).json(result);
	} catch (error) {
		next(error);
	}
});

app.patch("/api/story-memories/:memoryId", async (req, res, next) => {
	try {
		const memory = await updateDb(db => {
			const current = db.storyMemories.find(item => item.id === req.params.memoryId && item.userId === req.user.id);
			if (!current) throw Object.assign(new Error("作品记忆不存在"), { status: 404 });
			Object.assign(current, cleanStoryMemoryInput(req.body, { partial: true }));
			if (req.body.sourceChapterId !== undefined)
				current.sourceChapterId =
					req.body.sourceChapterId == null || req.body.sourceChapterId === ""
						? null
						: String(req.body.sourceChapterId);
			current.updatedAt = new Date().toISOString();
			return current;
		});
		res.json({ memory });
	} catch (error) {
		next(error);
	}
});

app.delete("/api/story-memories/:memoryId", async (req, res, next) => {
	try {
		await updateDb(db => {
			const exists = db.storyMemories.some(item => item.id === req.params.memoryId && item.userId === req.user.id);
			if (!exists) throw Object.assign(new Error("作品记忆不存在"), { status: 404 });
			db.storyMemories = db.storyMemories.filter(item => item.id !== req.params.memoryId);
		});
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/foreshadows", async (req, res, next) => {
	try {
		const db = await loadDb();
		const projectId = req.query.projectId ? String(req.query.projectId) : "";
		if (projectId) await projectOf(req.user.id, projectId);
		const status = req.query.status ? String(req.query.status) : "";
		if (status && !FORESHADOW_STATUSES.has(status)) throw Object.assign(new Error("伏笔状态无效"), { status: 400 });
		const foreshadows = db.foreshadows
			.filter(
				item =>
					item.userId === req.user.id &&
					(!projectId || item.projectId === projectId) &&
					(!status || item.status === status),
			)
			.sort(
				(left, right) =>
					Number(right.importance || 0) - Number(left.importance || 0) ||
					String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")),
			);
		res.json({ foreshadows });
	} catch (error) {
		next(error);
	}
});

app.post("/api/foreshadows", async (req, res, next) => {
	try {
		const title = cleanText(req.body?.title, "伏笔标题", 120);
		const content = cleanText(req.body?.content, "伏笔内容", 2000);
		const projectId = cleanOptionalText(req.body?.projectId, "作品 ID", 80);
		const result = await updateDb(db => {
			const plantChapterId =
				req.body?.plantChapterId == null || req.body?.plantChapterId === ""
					? null
					: String(req.body.plantChapterId);
			const targetChapterId =
				req.body?.targetChapterId == null || req.body?.targetChapterId === ""
					? null
					: String(req.body.targetChapterId);
			const resolvedChapterId =
				req.body?.resolvedChapterId == null || req.body?.resolvedChapterId === ""
					? null
					: String(req.body.resolvedChapterId);
			const status = req.body?.status || "planned";
			if (!FORESHADOW_STATUSES.has(status)) throw Object.assign(new Error("伏笔状态无效"), { status: 400 });
			const timestamp = new Date().toISOString();
			const foreshadow = {
				id: crypto.randomUUID(),
				userId: req.user.id,
				projectId,
				title,
				content,
				status,
				category: cleanOptionalText(req.body?.category, "伏笔分类", 40),
				importance: cleanIntegerRange(req.body?.importance, "重要性", 1, 5, 3),
				plantChapterId,
				targetChapterId,
				resolvedChapterId: status === "resolved" ? resolvedChapterId : null,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			db.foreshadows = [foreshadow, ...db.foreshadows];
			return foreshadow;
		});
		res.status(201).json({ foreshadow: result });
	} catch (error) {
		next(error);
	}
});

app.patch("/api/foreshadows/:foreshadowId", async (req, res, next) => {
	try {
		const result = await updateDb(db => {
			const foreshadow = db.foreshadows.find(
				item => item.id === req.params.foreshadowId && item.userId === req.user.id,
			);
			if (!foreshadow) throw Object.assign(new Error("伏笔不存在"), { status: 404 });
			if (req.body.title !== undefined) foreshadow.title = cleanText(req.body.title, "伏笔标题", 120);
			if (req.body.content !== undefined) foreshadow.content = cleanText(req.body.content, "伏笔内容", 2000);
			if (req.body.category !== undefined)
				foreshadow.category = cleanOptionalText(req.body.category, "伏笔分类", 40);
			if (req.body.importance !== undefined)
				foreshadow.importance = cleanIntegerRange(req.body.importance, "重要性", 1, 5, 3);
			if (req.body.status !== undefined) {
				if (!FORESHADOW_STATUSES.has(req.body.status))
					throw Object.assign(new Error("伏笔状态无效"), { status: 400 });
				foreshadow.status = req.body.status;
			}
			if (req.body.plantChapterId !== undefined)
				foreshadow.plantChapterId =
					req.body.plantChapterId == null || req.body.plantChapterId === ""
						? null
						: String(req.body.plantChapterId);
			if (req.body.targetChapterId !== undefined)
				foreshadow.targetChapterId =
					req.body.targetChapterId == null || req.body.targetChapterId === ""
						? null
						: String(req.body.targetChapterId);
			if (req.body.resolvedChapterId !== undefined)
				foreshadow.resolvedChapterId =
					req.body.resolvedChapterId == null || req.body.resolvedChapterId === ""
						? null
						: String(req.body.resolvedChapterId);
			if (foreshadow.status === "resolved" && !foreshadow.resolvedChapterId && req.body.chapterId !== undefined)
				foreshadow.resolvedChapterId = String(req.body.chapterId);
			if (foreshadow.status !== "resolved") foreshadow.resolvedChapterId = null;
			foreshadow.updatedAt = new Date().toISOString();
			return foreshadow;
		});
		res.json({ foreshadow: result });
	} catch (error) {
		next(error);
	}
});

app.delete("/api/foreshadows/:foreshadowId", async (req, res, next) => {
	try {
		await updateDb(db => {
			const exists = db.foreshadows.some(item => item.id === req.params.foreshadowId && item.userId === req.user.id);
			if (!exists) throw Object.assign(new Error("伏笔不存在"), { status: 404 });
			db.foreshadows = db.foreshadows.filter(item => item.id !== req.params.foreshadowId);
		});
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.get("/api/ideas", async (req, res, next) => {
	try {
		const db = await loadDb();
		const ideas = db.ideas
			.filter(idea => idea.userId === req.user.id)
			.sort(
				(left, right) =>
					Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
					String(right.updatedAt || right.createdAt || "").localeCompare(
						String(left.updatedAt || left.createdAt || ""),
					),
			);
		res.json({ ideas });
	} catch (error) {
		next(error);
	}
});

app.post("/api/ideas", async (req, res, next) => {
	try {
		const title = cleanText(req.body?.title, "灵感标题", 160);
		const body = cleanText(req.body?.body || "记录下此刻的想法。", "灵感内容", 10000);
		const projectId = req.body?.projectId || null;
		const timestamp = new Date().toISOString();
		const idea = {
			id: crypto.randomUUID(),
			userId: req.user.id,
			label: cleanText(req.body?.label || "灵感", "灵感类型", 20),
			title,
			body,
			color: ["coral", "teal", "yellow", "purple"][Math.floor(Math.random() * 4)],
			projectId,
			folder: req.body?.folder ? cleanText(req.body.folder, "素材目录", 40) : "未分类",
			tags: cleanTags(req.body?.tags),
			pinned: req.body?.pinned === true,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const result = await updateDb(db => {
			db.ideas = [idea, ...db.ideas];
			return idea;
		});
		res.status(201).json({ idea: result });
	} catch (error) {
		next(error);
	}
});

app.patch("/api/ideas/:ideaId", async (req, res, next) => {
	try {
		const result = await updateDb(db => {
			const idea = db.ideas.find(item => item.id === req.params.ideaId && item.userId === req.user.id);
			if (!idea) throw Object.assign(new Error("灵感不存在"), { status: 404 });
			if (req.body.title !== undefined) idea.title = cleanText(req.body.title, "灵感标题", 160);
			if (req.body.body !== undefined) idea.body = cleanText(req.body.body, "灵感内容", 10000);
			if (req.body.label !== undefined) idea.label = cleanText(req.body.label, "灵感类型", 20);
			if (req.body.folder !== undefined)
				idea.folder = req.body.folder ? cleanText(req.body.folder, "素材目录", 40) : "未分类";
			if (req.body.tags !== undefined) idea.tags = cleanTags(req.body.tags);
			if (req.body.pinned !== undefined) idea.pinned = req.body.pinned === true;
			if (req.body.projectId !== undefined) idea.projectId = req.body.projectId || null;
			idea.updatedAt = new Date().toISOString();
			return idea;
		});
		res.json({ idea: result });
	} catch (error) {
		next(error);
	}
});

app.delete("/api/ideas/:ideaId", async (req, res, next) => {
	try {
		await updateDb(db => {
			const exists = db.ideas.some(item => item.id === req.params.ideaId && item.userId === req.user.id);
			if (!exists) throw Object.assign(new Error("灵感不存在"), { status: 404 });
			db.ideas = db.ideas.filter(idea => idea.id !== req.params.ideaId);
		});
		res.status(204).end();
	} catch (error) {
		next(error);
	}
});

app.use("/api", (_req, res) => {
	res.status(404).json({ error: "接口不存在" });
});

app.use(express.static(distDir));
app.use((req, res, next) => {
	if (req.method === "GET" && req.accepts("html")) {
		res.sendFile(path.join(distDir, "index.html"));
		return;
	}
	next();
});

app.use((error, _req, res, _next) => {
	const status = Number.isInteger(error.status) ? error.status : 500;
	if (status >= 500) console.error(error);
	res.status(status).json({ error: status >= 500 ? "服务器内部错误" : error.message });
});

const server = app.listen(port, host, () => {
	const address = server.address();
	const actualPort = typeof address === "object" && address ? address.port : port;
	console.log(`YeMu API listening on http://${host}:${actualPort}`);
	const storage = storeInfo();
	console.log(`Storage: ${storage.backend}${storage.dataFile ? ` (${storage.dataFile})` : ""}`);
	if (usesDefaultSecret) console.warn("AUTH_SECRET is not set; use a strong secret in production.");
});

const websocket = new WebSocketServer({ noServer: true });

function websocketUserForRequest(req) {
	const authorization = req.headers.authorization || "";
	const headerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
	const url = new URL(req.url, "http://localhost");
	const queryToken = url.searchParams.get("token") || "";
	const token = headerToken || queryToken;
	if (token) return verifyAccessToken(token).catch(() => null);
	return Promise.resolve(null);
}

websocket.on("connection", async (ws, req) => {
	const userId = req.yemuUserId;
	const url = new URL(req.url, "http://localhost");
	const projectId = url.searchParams.get("project");
	if (!projectId || !userId) {
		ws.close(4001, "unauthorized");
		return;
	}
	const user = { ...userId, id: userId.sub || userId.id };
	let open = true;
	const pendingMessages = [];
	ws.on("message", raw => {
		if (!open) return;
		let message;
		try {
			message = JSON.parse(String(raw));
		} catch {
			return;
		}
		pendingMessages.push(message);
	});
	ws.on("close", () => {
		open = false;
		assistantBridge.detach(user.id, projectId, ws);
	});
	ws.on("error", () => {
		open = false;
		assistantBridge.detach(user.id, projectId, ws);
	});
	try {
		await projectOf(user.id, projectId);
	} catch {
		ws.close(4004, "project not found");
		return;
	}
	await assistantBridge.attach(user.id, projectId, ws);
	for (const message of pendingMessages) {
		assistantBridge.input(user.id, projectId, ws, message);
	}
});

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url, "http://localhost");
	if (url.pathname !== "/api/assistant") {
		socket.destroy();
		return;
	}
	void websocketUserForRequest(req).then(userId => {
		if (!userId) {
			socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
			socket.destroy();
			return;
		}
		websocket.handleUpgrade(req, socket, head, ws => {
			req.yemuUserId = userId;
			websocket.emit("connection", ws, req);
		});
	});
});

let shuttingDown = false;
async function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`Received ${signal}; shutting down YeMu API`);
	assistantBridge.shutdown();
	const closed = new Promise(resolve => server.close(resolve));
	const forceClose = setTimeout(() => server.closeAllConnections(), 8_000);
	await closed;
	clearTimeout(forceClose);
	await Promise.allSettled([closeStore()]);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => {
		void shutdown(signal).catch(error => {
			console.error("YeMu API shutdown failed:", error);
			process.exitCode = 1;
		});
	});
}
