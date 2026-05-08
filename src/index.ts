/**
 * Entrypoint for the claude-simplex-channel MCP server.
 *
 * Order of operations is load-bearing:
 *   1. `assertStdoutGate()` FIRST, before any import that could touch fd 1
 *      (notably `simplex-chat`, which pulls in the Haskell-built native
 *      addon at module-load time in some environments).
 *   2. Construct the SDK transport against fd 3 (the wrapper preserved the
 *      original stdout there via `3>&1 1>&2`).
 *   3. Connect the MCP server.
 *
 * Launched ONLY through `bin/claude-simplex-channel`. Direct `node` invocation
 * trips the gate and exits 2.
 */
import * as fs from "node:fs";

import { assertStdoutGate } from "./util/stdoutGate.js";

// Step 1: gate before anything else can write a single byte.
assertStdoutGate();

// Step 2 + 3: load SDK and build the transport against fd 3.
const { StdioServerTransport } = await import(
  "@modelcontextprotocol/sdk/server/stdio.js"
);
const { buildMcpServer } = await import("./mcp/server.js");
const { log } = await import("./util/log.js");

// fd 3 is the original stdout, preserved by the POSIX wrapper. The
// `null as unknown as string` cast appeases @types/node's createWriteStream
// signature — the runtime just needs `{ fd: 3 }` to bind the stream.
const sdkStdout = fs.createWriteStream(null as unknown as string, { fd: 3 });

const transport = new StdioServerTransport(process.stdin, sdkStdout);
const server = buildMcpServer();

await server.connect(transport);

log.info({ evt: "mcp_connected", name: "simplex", version: "0.1.0" });
