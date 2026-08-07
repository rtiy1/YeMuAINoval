import crypto from "node:crypto";
import path from "node:path";
import { readSkillPackage } from "./skill-market-storage.mjs";
import { extractSkillPromptContract } from "./skill-review.mjs";
import { loadDb } from "./store.mjs";

export function marketSkillKey(skillId) {
	return `market-${String(skillId || "")
		.replaceAll("-", "")
		.toLowerCase()}`;
}

export function isMarketSkillPublished(item) {
	return Boolean(
		item && item.status === "published" && item.review?.verdict === "allow" && item.review?.reviewer === "model",
	);
}

export function findMarketSkillByKey(db, key) {
	const normalized = String(key || "").toLowerCase();
	if (!/^market-[a-f0-9]{32}$/.test(normalized)) return null;
	return (db.skillMarketItems || []).find(item => marketSkillKey(item.id) === normalized) || null;
}

export async function decorateInstalledMarketSkill(userId, input) {
	if (input?.skill === "story-community") {
		throw Object.assign(new Error("社区 Skill 只能通过已导入的市场能力调用"), { status: 403 });
	}
	if (!String(input?.skill || "").startsWith("market-")) return input;
	const db = await loadDb();
	const item = findMarketSkillByKey(db, input.skill);
	if (!isMarketSkillPublished(item)) {
		throw Object.assign(new Error("该社区 Skill 未上架或已被下架"), { status: 404 });
	}
	const installed = (db.skillMarketInstalls || []).some(entry => entry.userId === userId && entry.skillId === item.id);
	if (!installed) throw Object.assign(new Error("请先在技能市场导入该 Skill"), { status: 403 });

	const buffer = await readSkillPackage(item.storageName);
	const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
	if (sha256 !== item.sha256) throw Object.assign(new Error("社区 Skill 文件完整性校验失败"), { status: 409 });
	const contract = extractSkillPromptContract({
		fileName: item.fileName,
		extension: path.extname(item.fileName).toLowerCase(),
		buffer,
	});
	return {
		...input,
		skill: "story-community",
		payload: {
			...(input.payload || {}),
			community_skill: {
				id: item.id,
				key: marketSkillKey(item.id),
				name: item.name,
				description: item.description,
				version: item.version,
				sha256: item.sha256,
				review: {
					riskLevel: item.review.riskLevel,
					reviewedAt: item.review.reviewedAt,
				},
				...contract,
			},
		},
	};
}
