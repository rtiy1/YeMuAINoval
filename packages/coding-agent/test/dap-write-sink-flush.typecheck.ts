import type { DapClient } from "@yemu/agent-runtime/dap/client";

// Type-only import forces standard TypeScript to check src/dap/client.ts,
// including the socketToSink() implementation against DapWriteSink.flush().
type _CheckDapClient = DapClient;
