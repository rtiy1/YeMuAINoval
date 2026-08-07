// Install a reviewed skill archive into a workspace's .claude/skills/ folder
// so the embedded CLI discovers it as a native Skill.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";

const MAX_ARCHIVE_ENTRIES = 200;
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([
	"",
	".md",
	".markdown",
	".txt",
	".json",
	".jsonc",
	".yaml",
	".yml",
	".toml",
	".js",
	".mjs",
	".cjs",
	".jsx",
	".ts",
	".tsx",
	".py",
	".sh",
	".ps1",
	".bat",
	".cmd",
	".html",
	".css",
	".svg",
	".xml",
	".ini",
	".cfg",
	".conf",
	".sql",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".svg",
]);

export async function installSkillPackage(skillsRoot, archiveBuffer, name) {
	const safeName = String(name || "skill")
		.trim()
		.replace(/[^a-z0-9-]+/giu, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
	const targetDir = path.join(skillsRoot, safeName || "skill");
	await mkdir(targetDir, { recursive: true });

	const files = unzipSync(archiveBuffer, {
		filter: entry => {
			if (entry.name.endsWith("/")) return true;
			return ALLOWED_EXTENSIONS.has(path.extname(entry.name).toLowerCase());
		},
	});

	const entries = Object.entries(files).filter(([fileName]) => !fileName.endsWith("/"));
	if (!entries.length) throw new Error("Skill 归档中没有可安装的文件");
	if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("Skill 归档文件过多");

	let totalBytes = 0;
	for (const [, data] of entries) totalBytes += data.byteLength;
	if (totalBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("Skill 归档解压后过大");

	for (const [fileName, data] of entries) {
		const relative = fileName.replace(/^\/+/u, "");
		const target = path.join(targetDir, relative);
		if (!target.startsWith(targetDir)) continue;
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, data);
	}
	return safeName;
}
