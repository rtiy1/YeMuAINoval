import {
	AuthBrokerClient,
	type AuthBrokerServerHandle,
	discoverAuthStorage,
	startAuthBroker,
} from "@yemu/model-runtime/auth-broker";
import type { AuthStorage } from "@yemu/model-runtime/auth-storage";

declare global {
	var __authBrokerWireConstructionCount: number;
}

const agentDir = process.argv[2];
if (!agentDir) throw new Error("Expected an isolated agent directory");

const count = (): number => globalThis.__authBrokerWireConstructionCount;

const counts = {
	afterModuleImport: count(),
	afterLocalDiscovery: -1,
	afterConstruction: -1,
	afterFirstHealth: -1,
	afterSecondHealth: -1,
};
let storage: AuthStorage | undefined;
let handle: AuthBrokerServerHandle | undefined;

try {
	delete process.env.YEMU_AUTH_BROKER_URL;
	delete process.env.YEMU_AUTH_BROKER_TOKEN;
	delete process.env.YEMU_AUTH_BROKER_ACCOUNT_POOL_FILE;

	storage = await discoverAuthStorage({ agentDir });
	counts.afterLocalDiscovery = count();

	handle = startAuthBroker({
		storage,
		bind: "127.0.0.1:0",
		bearerTokens: [],
		version: "wire-lazy-probe",
		disableRefresher: true,
	});
	const client = new AuthBrokerClient({ url: handle.url, token: "unused", maxRetries: 0 });
	counts.afterConstruction = count();

	const firstHealth = await client.healthz();
	counts.afterFirstHealth = count();
	const secondHealth = await client.healthz();
	counts.afterSecondHealth = count();

	process.stdout.write(JSON.stringify({ counts, firstHealth, secondHealth }));
} finally {
	await handle?.close();
	storage?.close();
}
