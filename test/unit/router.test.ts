/**
 * Inbound router unit tests — PR 8a, plan §8 step 8a.
 *
 * Verbatim test names mandated by the task spec:
 *   - permission_regex_without_pending_forwards_as_chat
 *   - permission_id_mismatch_forwards_as_chat
 *   - regex_matches_normal_chat_no_admin_forwards_as_chat
 *
 * Strategy: drive `makeHandleInbound` with a fake `ownerGate` (always true)
 * and a fake `forwardChat` that records the call. Inject a stub
 * `emitVerdict` via `setEmitVerdict` and assert it is NOT called when the
 * 2-step gate routes to chat. The router never imports MCP — the test does
 * not need an in-memory transport pair.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as pending from "../../src/channel/pendingPermReqs.js";
import {
  __test_reset,
  makeHandleInbound,
  setEmitVerdict,
  type Action,
  type InboundMsg,
} from "../../src/channel/router.js";

const ALWAYS_OWNER = (): boolean => true;
const NEVER_OWNER = (): boolean => false;

const SENDER = { contactId: 42, profileSha256: "deadbeef".repeat(8) };

function makeMsg(text: string): InboundMsg {
  return { from: SENDER, text };
}

let forwardChatCalls: InboundMsg[];
let forwardChat: (msg: InboundMsg) => Action;
let emitVerdict: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pending.__test_reset();
  __test_reset();
  forwardChatCalls = [];
  forwardChat = (msg: InboundMsg): Action => {
    forwardChatCalls.push(msg);
    return { kind: "chat", msg };
  };
  emitVerdict = vi.fn(async (id: string, allow: boolean, msg: InboundMsg) => {
    return { kind: "verdict", allow, id } satisfies Action;
  });
  setEmitVerdict(emitVerdict);
});

afterEach(() => {
  pending.__test_reset();
  __test_reset();
});

describe("router handleInbound", () => {
  it("drops messages from non-owner senders", () => {
    const handle = makeHandleInbound({
      ownerGate: NEVER_OWNER,
      forwardChat,
    });
    const result = handle(makeMsg("anything")) as Action;
    expect(result).toEqual({ kind: "drop" });
    expect(forwardChatCalls).toHaveLength(0);
    expect(emitVerdict).not.toHaveBeenCalled();
  });

  it("permission_regex_without_pending_forwards_as_chat", () => {
    // Regex matches but `pendingPermReqs` is empty.
    const handle = makeHandleInbound({
      ownerGate: ALWAYS_OWNER,
      forwardChat,
    });
    const result = handle(makeMsg("yes bcdef")) as Action;
    expect(result.kind).toBe("chat");
    expect(forwardChatCalls).toHaveLength(1);
    expect(forwardChatCalls[0].text).toBe("yes bcdef");
    expect(emitVerdict).not.toHaveBeenCalled();
  });

  it("permission_id_mismatch_forwards_as_chat", () => {
    // Regex matches with id `bcdef` but pending only has `kmnpq`.
    pending.set("kmnpq", "Bash", "ls");
    const handle = makeHandleInbound({
      ownerGate: ALWAYS_OWNER,
      forwardChat,
    });
    const result = handle(makeMsg("yes bcdef")) as Action;
    expect(result.kind).toBe("chat");
    expect(forwardChatCalls).toHaveLength(1);
    expect(forwardChatCalls[0].text).toBe("yes bcdef");
    expect(emitVerdict).not.toHaveBeenCalled();
  });

  it("regex_matches_normal_chat_no_admin_forwards_as_chat", () => {
    // Defensive: "no admin" is 5 chars after "no" but contains 'a' which is
    // outside [a-km-z], so the regex MUST NOT match. Even if a future edit
    // accidentally widened the class, the forward-as-chat fallback kicks in
    // because no pending entry shares the id "admin".
    const handle = makeHandleInbound({
      ownerGate: ALWAYS_OWNER,
      forwardChat,
    });
    const result = handle(makeMsg("no admin")) as Action;
    expect(result.kind).toBe("chat");
    expect(forwardChatCalls).toHaveLength(1);
    expect(forwardChatCalls[0].text).toBe("no admin");
    expect(emitVerdict).not.toHaveBeenCalled();
  });

  it("emits a verdict when regex matches and pending exists", async () => {
    pending.set("BCDEF", "Bash", "ls");
    const handle = makeHandleInbound({
      ownerGate: ALWAYS_OWNER,
      forwardChat,
    });
    const result = await (handle(makeMsg("YES bcdef")) as Promise<Action>);
    expect(emitVerdict).toHaveBeenCalledTimes(1);
    expect(emitVerdict).toHaveBeenCalledWith(
      "bcdef",
      true,
      expect.objectContaining({ text: "YES bcdef" }),
    );
    expect(result).toEqual({ kind: "verdict", allow: true, id: "bcdef" });
    expect(forwardChatCalls).toHaveLength(0);
  });

  it("recognises both yes/y and no/n with case insensitivity", async () => {
    pending.set("hjkmn", "Bash", "rm");
    pending.set("pqrst", "Bash", "rm");
    const handle = makeHandleInbound({
      ownerGate: ALWAYS_OWNER,
      forwardChat,
    });

    await (handle(makeMsg("y hjkmn")) as Promise<Action>);
    expect(emitVerdict).toHaveBeenLastCalledWith(
      "hjkmn",
      true,
      expect.anything(),
    );

    await (handle(makeMsg("N pqrst")) as Promise<Action>);
    expect(emitVerdict).toHaveBeenLastCalledWith(
      "pqrst",
      false,
      expect.anything(),
    );
  });

  it("tolerates leading/trailing whitespace per the regex \\s* anchors", async () => {
    pending.set("vwxyz", "Bash", "rm");
    const handle = makeHandleInbound({
      ownerGate: ALWAYS_OWNER,
      forwardChat,
    });
    await (handle(makeMsg("   yes vwxyz   ")) as Promise<Action>);
    expect(emitVerdict).toHaveBeenCalledTimes(1);
  });
});
