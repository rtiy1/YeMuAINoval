import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type MCPServer, mcpCapability } from "@yemu/agent-runtime/capability/mcp";
import { loadCapability } from "@yemu/agent-runtime/discovery";
import { removeWithRetries } from "@yemu/utils";

async function loadStandaloneMcpConfig(cwd: string): Promise<MCPServer[]> {
	const result = await loadCapability<MCPServer>(mcpCapability.id, {
		cwd,
		providers: ["mcp-json"],
	});
	return result.items;
}

function envPlaceholder(name: string): string {
	return `\${${name}}`;
}

describe("standalone mcp.json oauth env expansion", () => {
	let tempDir = "";
	const originalEnv = {
		YEMU_OAUTH_TOKEN_URL: process.env.YEMU_OAUTH_TOKEN_URL,
		YEMU_OAUTH_CLIENT_ID: process.env.YEMU_OAUTH_CLIENT_ID,
		YEMU_OAUTH_CLIENT_SECRET: process.env.YEMU_OAUTH_CLIENT_SECRET,
		YEMU_OAUTH_REDIRECT_URI: process.env.YEMU_OAUTH_REDIRECT_URI,
		YEMU_OAUTH_CALLBACK_PATH: process.env.YEMU_OAUTH_CALLBACK_PATH,
		YEMU_MCP_HEADER: process.env.YEMU_MCP_HEADER,
		YEMU_MCP_URL: process.env.YEMU_MCP_URL,
		YEMU_MCP_ENV: process.env.YEMU_MCP_ENV,
	};

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yemu-mcp-json-"));
		process.env.YEMU_OAUTH_TOKEN_URL = "https://provider.example/token";
		process.env.YEMU_OAUTH_CLIENT_ID = "oauth-client-id";
		process.env.YEMU_OAUTH_CLIENT_SECRET = "oauth-client-secret";
		process.env.YEMU_OAUTH_REDIRECT_URI = "https://public.example/oauth/callback";
		process.env.YEMU_OAUTH_CALLBACK_PATH = "/oauth/callback";
		process.env.YEMU_MCP_HEADER = "Bearer test-token";
		process.env.YEMU_MCP_URL = "https://mcp.example.com";
		process.env.YEMU_MCP_ENV = "env-value";
	});

	afterEach(async () => {
		await removeWithRetries(tempDir);
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	test("expands standalone auth and oauth fields alongside existing env-expanded fields", async () => {
		await fs.writeFile(
			path.join(tempDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					figma: {
						url: `${envPlaceholder("YEMU_MCP_URL")}/mcp`,
						headers: { Authorization: envPlaceholder("YEMU_MCP_HEADER") },
						env: { MCP_VALUE: envPlaceholder("YEMU_MCP_ENV") },
						auth: {
							type: "oauth",
							tokenUrl: envPlaceholder("YEMU_OAUTH_TOKEN_URL"),
							clientId: envPlaceholder("YEMU_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("YEMU_OAUTH_CLIENT_SECRET"),
						},
						oauth: {
							clientId: envPlaceholder("YEMU_OAUTH_CLIENT_ID"),
							clientSecret: envPlaceholder("YEMU_OAUTH_CLIENT_SECRET"),
							redirectUri: envPlaceholder("YEMU_OAUTH_REDIRECT_URI"),
							callbackPort: 4317,
							callbackPath: envPlaceholder("YEMU_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.url).toBe("https://mcp.example.com/mcp");
		expect(server?.headers).toEqual({ Authorization: "Bearer test-token" });
		expect(server?.env).toEqual({ MCP_VALUE: "env-value" });
		expect(server?.auth).toEqual({
			type: "oauth",
			tokenUrl: "https://provider.example/token",
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
		});
		expect(server?.oauth).toEqual({
			clientId: "oauth-client-id",
			clientSecret: "oauth-client-secret",
			redirectUri: "https://public.example/oauth/callback",
			callbackPort: 4317,
			callbackPath: "/oauth/callback",
		});
	});

	test("expands only the standalone oauth fields that are present", async () => {
		await fs.writeFile(
			path.join(tempDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					slack: {
						url: "https://slack.example.com/mcp",
						oauth: {
							redirectUri: envPlaceholder("YEMU_OAUTH_REDIRECT_URI"),
							callbackPath: envPlaceholder("YEMU_OAUTH_CALLBACK_PATH"),
						},
					},
				},
			}),
		);

		const [server] = await loadStandaloneMcpConfig(tempDir);
		expect(server).toBeDefined();
		expect(server?.oauth).toEqual({
			redirectUri: "https://public.example/oauth/callback",
			callbackPath: "/oauth/callback",
		});
		expect(server?.auth).toBeUndefined();
	});
});
