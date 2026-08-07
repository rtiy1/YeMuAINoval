import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultJsonFile = process.env.STORY_DATA_FILE || path.join(rootDir, "server", "data", "db.json");
const action = process.argv[2] || "status";

if (action !== "status" && !String(process.env.DATABASE_URL || "").trim()) {
	console.error("DATABASE_URL is required for database migration commands");
	process.exit(1);
}

const { closeStore, loadDb, replaceDb, storeInfo } = await import("./store.mjs");

try {
	if (action === "import") {
		const source = process.argv[3] || defaultJsonFile;
		const parsed = JSON.parse(await readFile(source, "utf8"));
		await replaceDb(parsed);
		console.log(`Imported JSON data from ${source} into ${storeInfo().backend}.`);
	} else if (action === "export") {
		const target = process.argv[3] || defaultJsonFile;
		const db = await loadDb();
		await writeFile(target, JSON.stringify(db, null, 2), "utf8");
		console.log(`Exported ${storeInfo().backend} data to ${target}.`);
	} else if (action === "status") {
		const db = await loadDb();
		console.log(JSON.stringify({ ...storeInfo(), users: db.users.length, projects: db.projects.length }, null, 2));
	} else {
		console.error("Usage: node server/db-cli.mjs <status|import|export> [file]");
		process.exitCode = 1;
	}
} finally {
	await closeStore();
}
