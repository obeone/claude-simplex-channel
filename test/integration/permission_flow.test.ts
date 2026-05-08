/**
 * Permission flow integration test — PR 8b, plan §8 step 8b.
 *
 * Verbatim test names mandated by the task spec:
 *   - `owner_only_verdict_emitted`
 *   - `non_owner_verdict_forwarded_as_chat`
 *   - `verdict_consumes_pending_entry`
 *
 * Strategy: drive the *real* `makeHandleInbound` (PR 8a) wired against the
 * *real* `makeEmitVerdict` (PR 8b) and the *real* `pendingPermReqs` store
 * (PR 7). Stub only the two crossing-cuts:
 *   - `ownerStore.matches` — toggled per-test to model owner / non-owner senders.
 *   - The MCP `Server` — replaced with `{ notification: vi.fn() }` so we
 *     observe the framed payload without an in-memory transport pair.
 *
 * The router never imports MCP; the verdict module imports only
 * `Server.notification`. Together this means the test exercises the
 * complete decision pipeline (regex → pending lookup → owner-tuple gate →
 * notification → consume) without spinning up the SDK.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as pendingPermReqs from "../../src/channel/pendingPermReqs.js";
import {
  __test_reset as routerReset,
  makeHandleInbound,
  setEmitVerdict,
  type Action,
  type ForwardChat,
  type InboundMsg,
  type InboundSender,
  type OwnerGate,
} from "../../src/channel/router.js";
import {
  PERMISSION_VERDICT_METHOD,
  makeEmitVerdict,
  type NotificationServerLike,
  type OwnerStoreLike,
} from "../../src/channel/verdict.js";

const OWNER_SHA = "a".repeat(64);
const STRANGER_SHA = "b".repeat(64);
const OWNER: InboundSender = { contactId: 7, profileSha256: OWNER_SHA };
const STRANGER: InboundSender = { contactId: 99, profileSha256: STRANGER_SHA };

/** Predicate the router uses for the coarse allowlist gate (NOT the strict tuple). */
const ALLOWLIST_ANY: OwnerGate = (): boolean => true;

/** Build an owner-store stub that matches a single tuple. */
function ownerOnly(sender: InboundSender): OwnerStoreLike {
  return {
    matches(contactId, sha) {
      return contactId === sender.contactId && sha === sender.profileSha256;
    },
  };
}

let server: NotificationServerLike & { notification: ReturnType<typeof vi.fn> };
let forwardChatCalls: InboundMsg[];
let forwardChat: ForwardChat;

beforeEach(() => {
  pendingPermReqs.__test_reset();
  routerReset();
  server = {
    notification: vi.fn().mockResolvedValue(undefined),
  };
  forwardChatCalls = [];
  forwardChat = (msg: InboundMsg): Action => {
    forwardChatCalls.push(msg);
    return { kind: "chat", msg };
  };
});

afterEach(() => {
  pendingPermReqs.__test_reset();
  routerReset();
});

describe("permission flow (router + verdict integration)", () => {
  it("owner_only_verdict_emitted", async () => {
    pendingPermReqs.set("hjkmn", "Bash", "ls");
    setEmitVerdict(
      makeEmitVerdict({
        server,
        forwardChat,
        ownerStore: ownerOnly(OWNER),
        pendingPermReqs,
      }),
    );
    const handle = makeHandleInbound({ ownerGate: ALLOWLIST_ANY, forwardChat });

    const result = (await handle({
      from: OWNER,
      text: "yes hjkmn",
    })) as Action;

    expect(result).toEqual({ kind: "verdict", allow: true, id: "hjkmn" });
    expect(server.notification).toHaveBeenCalledTimes(1);
    expect(server.notification).toHaveBeenCalledWith({
      method: PERMISSION_VERDICT_METHOD,
      params: { request_id: "hjkmn", behavior: "allow" },
    });
    expect(forwardChatCalls).toHaveLength(0);
  });

  it("non_owner_verdict_forwarded_as_chat", async () => {
    // Pending entry exists for `hjkmn`, but the sender is allowlisted-but-NOT-owner.
    // The strict tuple gate inside emitVerdict must forward as chat without
    // emitting a verdict.
    pendingPermReqs.set("hjkmn", "Bash", "ls");
    setEmitVerdict(
      makeEmitVerdict({
        server,
        forwardChat,
        ownerStore: ownerOnly(OWNER),
        pendingPermReqs,
      }),
    );
    const handle = makeHandleInbound({ ownerGate: ALLOWLIST_ANY, forwardChat });

    const result = (await handle({
      from: STRANGER,
      text: "yes hjkmn",
    })) as Action;

    expect(result.kind).toBe("chat");
    expect(server.notification).not.toHaveBeenCalled();
    expect(forwardChatCalls).toHaveLength(1);
    expect(forwardChatCalls[0]).toEqual({ from: STRANGER, text: "yes hjkmn" });
    // Pending entry MUST survive — a stranger's spoof attempt cannot
    // burn the owner's verdict opportunity.
    expect(pendingPermReqs.get("hjkmn")).toBeDefined();
  });

  it("verdict_consumes_pending_entry", async () => {
    pendingPermReqs.set("pqrst", "Write", "/etc/hosts");
    setEmitVerdict(
      makeEmitVerdict({
        server,
        forwardChat,
        ownerStore: ownerOnly(OWNER),
        pendingPermReqs,
      }),
    );
    const handle = makeHandleInbound({ ownerGate: ALLOWLIST_ANY, forwardChat });

    expect(pendingPermReqs.get("pqrst")).toBeDefined();
    await handle({ from: OWNER, text: "no pqrst" });

    // Plan §8 step 8b: after emit, pendingPermReqs.has(id) === false.
    expect(pendingPermReqs.get("pqrst")).toBeUndefined();
    expect(server.notification).toHaveBeenCalledWith({
      method: PERMISSION_VERDICT_METHOD,
      params: { request_id: "pqrst", behavior: "deny" },
    });

    // A second `yes pqrst` from the owner now falls through to chat
    // (single-use intent — duplicate verdict must NOT re-emit).
    forwardChatCalls.length = 0;
    server.notification.mockClear();
    const result = (await handle({
      from: OWNER,
      text: "yes pqrst",
    })) as Action;
    expect(result.kind).toBe("chat");
    expect(server.notification).not.toHaveBeenCalled();
    expect(forwardChatCalls).toHaveLength(1);
  });

  it("notification failure still consumes the pending entry (fail-closed)", async () => {
    pendingPermReqs.set("vwxyz", "Bash", "rm -rf /");
    server.notification.mockRejectedValueOnce(new Error("transport closed"));
    setEmitVerdict(
      makeEmitVerdict({
        server,
        forwardChat,
        ownerStore: ownerOnly(OWNER),
        pendingPermReqs,
      }),
    );
    const handle = makeHandleInbound({ ownerGate: ALLOWLIST_ANY, forwardChat });

    await handle({ from: OWNER, text: "yes vwxyz" });
    // The half-emitted verdict MUST be consumed so it cannot replay.
    expect(pendingPermReqs.get("vwxyz")).toBeUndefined();
  });

  it("router stays sync between regex match and pending lookup", () => {
    // Regression guard for the SINGLE-THREADED CONTRACT: the router must
    // return synchronously for the no-match path (no pending entry) so
    // there is no `await` window between the regex hit and the gate.
    setEmitVerdict(
      makeEmitVerdict({
        server,
        forwardChat,
        ownerStore: ownerOnly(OWNER),
        pendingPermReqs,
      }),
    );
    const handle = makeHandleInbound({ ownerGate: ALLOWLIST_ANY, forwardChat });

    // No pending entry, regex matches → SYNC chat action.
    const result = handle({ from: OWNER, text: "yes bcdef" });
    expect((result as Action).kind).toBe("chat");
    // Crucially, NOT a Promise.
    expect(result).not.toHaveProperty("then");
  });
});
