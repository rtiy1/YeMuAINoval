export function normalizeApiBase(value) {
	const input = String(value || "").trim();
	if (!input) return "/api";
	if (input.startsWith("/")) return input.replace(/\/+$/, "") || "/api";

	const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `http://${input}`;
	let url;
	try {
		url = new URL(withProtocol);
	} catch {
		throw new Error("服务器地址格式不正确");
	}
	if (!["http:", "https:"].includes(url.protocol)) throw new Error("服务器地址仅支持 HTTP 或 HTTPS");
	url.username = "";
	url.password = "";
	url.search = "";
	url.hash = "";
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = /\/api$/i.test(path) ? path : `${path}/api`;
	return url.toString().replace(/\/$/, "");
}

export function getApiBase() {
	const configured = import.meta.env.VITE_API_URL;
	if (configured) return normalizeApiBase(configured);
	return "/api";
}

export async function appFetch(input, init) {
	return globalThis.fetch(input, init);
}

export async function sendAgentNotification({ title, body }) {
	if (typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()) return false;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
	new Notification(String(title || "夜幕 AI 小说"), { body: String(body || "") });
	return true;
}

function safeFileName(value, fallback = "文稿.txt") {
	const normalized = String(value || "")
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
		.replace(/[. ]+$/g, "")
		.trim();
	return normalized || fallback;
}

function browserDownload({ fileName, content, mimeType }) {
	const blob = new Blob([content], { type: mimeType });
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	anchor.click();
	URL.revokeObjectURL(url);
}

export async function saveTextDocument({ fileName, content }) {
	const normalizedName = safeFileName(fileName);
	browserDownload({ fileName: normalizedName, content, mimeType: "text/plain;charset=utf-8" });
	return { saved: true, path: null };
}
