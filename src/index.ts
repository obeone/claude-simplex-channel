/**
 * Entrypoint for the claude-simplex-channel MCP server.
 *
 * Order of operations is load-bearing:
 *   1. `assertStdoutGate()` FIRST, before any import that could touch fd 1
 *      (notably `simplex-chat`, which pulls in the Haskell-built native
 *      addon at module-load time in some environments).
 *   2. Load the owner store synchronously into the in-memory cache so the
 *      MCP `reply` tool's allowlist gate (and later the inbound router) can
 *      decide on the same event-loop turn — no async I/O on the hot path.
 *   3. Bring up the SimpleX adapter. This loads the native addon (after the
 *      stdout fence is in place) and returns the live `ChatApi` handle the
 *      `reply` tool needs to emit `apiSendMessages`.
 *   4. Construct the SDK transport against fd 3 (the wrapper preserved the
 *      original stdout there via `3>&1 1>&2`).
 *   5. Build the MCP server with the tool deps (api + sync allowlist
 *      predicate) and connect it.
 *
 * Launched ONLY through `bin/claude-simplex-channel`. Direct `node` invocation
 * trips the gate and exits 2.
 */
import * as fs from "node:fs";

import { assertStdoutGate } from "./util/stdoutGate.js";

// Step 1: gate before anything else can write a single byte.
assertStdoutGate();

// Steps 2-5: lazy imports keep the simplex-chat addon load AFTER the gate.
const { loadOwnerStore, getOwnerSnapshot } = await import("./owner/store.js");
const { startSimplexAdapter } = await import("./simplex/adapter.js");
const { StdioServerTransport } = await import(
  "@modelcontextprotocol/sdk/server/stdio.js"
);
const { buildMcpServer } = await import("./mcp/server.js");
const { log } = await import("./util/log.js");

await loadOwnerStore();

const adapter = await startSimplexAdapter({
  onReady: (payload) => {
    // PR 6 scope: log the ready payload. The MCP `notifications/claude/channel`
    // emission with `meta.kind=adapter_ready` is wired in a later PR (the
    // notification helper depends on the connected `Server` handle, which we
    // build immediately below; emitting it here would require either a forward
    // reference or splitting the bring-up into two phases).
    log.info({
      evt: "adapter_ready",
      address_present: payload.address !== null,
      db_path: payload.db_path,
      owner_status:
        getOwnerSnapshot().ownerContactId !== null ? "bound" : "unbound",
    });
  },
});

// fd 3 is the original stdout, preserved by the POSIX wrapper. The
// `null as unknown as string` cast appeases @types/node's createWriteStream
// signature — the runtime just needs `{ fd: 3 }` to bind the stream.
const sdkStdout = fs.createWriteStream(null as unknown as string, { fd: 3 });

const transport = new StdioServerTransport(process.stdin, sdkStdout);
const server = buildMcpServer({
  tools: {
    api: adapter.api,
    // Synchronous allowlist predicate. Today the only outbound-allowed
    // contact is the bound owner. Worker-state's PR 5 (pairing) will widen
    // this to also include pair-code-admitted contacts via `Allowlist.has()`;
    // that wiring lives in this entrypoint and is the correct extension
    // point — `src/mcp/tools.ts` stays predicate-agnostic.
    isAllowedContact: (contactId: number): boolean => {
      const snap = getOwnerSnapshot();
      return snap.ownerContactId !== null && snap.ownerContactId === contactId;
    },
  },
});

await server.connect(transport);

log.info({ evt: "mcp_connected", name: "simplex", version: "0.1.0" });
