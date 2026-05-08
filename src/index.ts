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
const ownerStore = await import("./owner/store.js");
const { loadOwnerStore, getOwnerSnapshot } = ownerStore;
const { startSimplexAdapter } = await import("./simplex/adapter.js");
const { StdioServerTransport } = await import(
  "@modelcontextprotocol/sdk/server/stdio.js"
);
const { buildMcpServer } = await import("./mcp/server.js");
const { installPermissionRequestHandler } = await import("./mcp/permission.js");
const pendingPermReqs = await import("./channel/pendingPermReqs.js");
const routerMod = await import("./channel/router.js");
const { makeHandleInbound, setEmitVerdict } = routerMod;
type InboundMsg = import("./channel/router.js").InboundMsg;
type Action = import("./channel/router.js").Action;
const { makeEmitVerdict } = await import("./channel/verdict.js");
const { profileSha256 } = await import("./channel/pairing.js");
const { installContactUpdatedDemotion } = await import("./simplex/profile.js");
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

// PR 7: register the permission_request notification handler before connect
// so any notification arriving on the very first ready frame is dispatched.
installPermissionRequestHandler({
  server,
  api: adapter.api,
  getOwnerContactId: () => getOwnerSnapshot().ownerContactId,
});

await server.connect(transport);

log.info({ evt: "mcp_connected", name: "simplex", version: "0.1.0" });

// PR 8b: wire the inbound 2-step verdict pipeline.
//
//   forwardChat:  closure that maps the router's `chat` action to an MCP
//                 `notifications/claude/channel` notification. Fire-and-forget
//                 — the notification promise is logged on rejection but does
//                 not block the inbound subscriber.
//
//   ownerGate:    coarse allowlist gate (PR 8a contract). For now the only
//                 admitted contact is the bound owner; worker-state's
//                 `Allowlist.hasContactId(...)` will be OR-merged here once
//                 pairing is wired into this entrypoint.
//
//   emitVerdict:  strict tuple-match + verdict notification (PR 8b proper).
//                 See `src/channel/verdict.ts`.
const forwardChat = (msg: InboundMsg): Action => {
  void server
    .notification({
      method: "notifications/claude/channel",
      params: {
        chat_id: String(msg.from.contactId),
        text: msg.text,
        meta: { kind: "chat", contact_id: msg.from.contactId },
      },
    })
    .catch((err: unknown) => {
      log.error({
        evt: "channel_forward_failed",
        contact_id: msg.from.contactId,
        error: String(err),
      });
    });
  return { kind: "chat", msg };
};

setEmitVerdict(
  makeEmitVerdict({ server, forwardChat, ownerStore, pendingPermReqs }),
);

const handleInbound = makeHandleInbound({
  ownerGate: (sender) =>
    ownerStore.matches(sender.contactId, sender.profileSha256),
  forwardChat,
});

adapter.events.on("newChatItems", (event) => {
  for (const ci of event.chatItems) {
    if (ci.chatInfo.type !== "direct") continue;
    const direction = ci.chatItem.chatDir;
    if (!direction || !direction.type?.startsWith("directRcv")) continue;
    const content = ci.chatItem.content;
    if (content.type !== "rcvMsgContent") continue;
    const msgContent = content.msgContent;
    if (msgContent.type !== "text") continue;
    const contact = ci.chatInfo.contact;
    const result = handleInbound({
      from: {
        contactId: contact.contactId,
        profileSha256: profileSha256(contact.profile),
      },
      text: msgContent.text,
    });
    // Verdict path returns a promise; surface failures so they don't get lost.
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        log.error({
          evt: "inbound_dispatch_failed",
          contact_id: contact.contactId,
          error: String(err),
        });
      });
    }
  }
});

log.info({ evt: "inbound_router_wired" });

// PR 9: ContactUpdated → owner demotion. Subscribed AFTER the inbound
// router so that on a profile-change event the owner cache is cleared
// before any subsequent inbound DM (delivered as a later `newChatItems`
// event in the same SimpleX stream) reaches the verdict gate.
installContactUpdatedDemotion({ events: adapter.events });

log.info({ evt: "contact_updated_demotion_wired" });
