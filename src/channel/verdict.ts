/**
 * Owner-gated verdict emission — v2 plan §8 step 8b.
 *
 * The third gate of the inbound 2-step verdict pipeline. Called by the
 * router (`src/channel/router.ts`, PR 8a) ONLY after:
 *   1. The coarse owner-gate accepted the sender (sender is allowlisted).
 *   2. The verdict-shape regex matched (`yes <id>` / `no <id>`).
 *   3. `pendingPermReqs.get(id)` returned a live entry.
 *
 * This module performs the strict owner-tuple match and, on hit, emits the
 * MCP `notifications/claude/channel/permission` verdict and consumes the
 * pending entry. On miss (sender is allowlisted but NOT the bound owner —
 * e.g. a pair-code-admitted contact who happens to type a verdict shape
 * matching an in-flight id), the message is forwarded as a chat
 * notification per the plan's "anything else is forwarded" rule.
 *
 * Why the verdict implementation lives outside `router.ts`: the router is
 * the only synchronous module on the inbound hot path (PR 8a's contract).
 * Importing `Server` here keeps router.ts free of MCP coupling, which in
 * turn lets the router be unit-tested without an in-memory transport pair
 * (see `test/unit/router.test.ts`). The router exposes a `setEmitVerdict`
 * setter so the entrypoint can wire `makeEmitVerdict()` after the server
 * is connected.
 *
 * SINGLE-THREADED CONTRACT (mirrored in router + pendingPermReqs):
 *   - `ownerStore.matches` is SYNC. There is NO `await` between the
 *     pendingPermReqs hit and the owner-tuple check.
 *   - The first `await` is `server.notification(...)`. By the time that
 *     resolves, the verdict decision is already finalized and durable;
 *     `pendingPermReqs.del(id)` afterwards is a single-writer cleanup.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { log } from "../util/log.js";
import * as defaultPendingPermReqs from "./pendingPermReqs.js";
import * as defaultOwnerStore from "../owner/store.js";
import type { Action, EmitVerdict, ForwardChat, InboundMsg } from "./router.js";

/** MCP method name verbatim per plan §8 step 8b. */
export const PERMISSION_VERDICT_METHOD =
  "notifications/claude/channel/permission";

/**
 * Minimal surface of `pendingPermReqs` the verdict needs.
 *
 * Only `del` is consumed; the lookup happened in the router before we got
 * here. Typed narrowly so tests can pass a stub without re-implementing the
 * full sweep/TTL machinery.
 */
export interface PendingPermReqsLike {
  del(id: string): void;
  has?(id: string): boolean;
}

/**
 * Minimal surface of `ownerStore` the verdict needs.
 *
 * SYNC. Strictly. No `await`. Plan §8 step 7 + 8b.
 */
export interface OwnerStoreLike {
  matches(contactId: number, profileSha256: string): boolean;
}

/**
 * Minimal surface of MCP `Server` the verdict needs.
 *
 * Typed against `Pick<Server, "notification">` so tests can pass an object
 * literal without instantiating a real server. The notification payload is
 * `{ method, params }` — see `Protocol.notification` in the SDK.
 */
export interface NotificationServerLike {
  notification(notification: {
    method: string;
    params: Record<string, unknown>;
  }): Promise<void>;
}

/** Dependencies for `makeEmitVerdict`. */
export interface VerdictDeps {
  server: NotificationServerLike;
  /** Forward-chat callback shared with the router (the `chat` action it returns). */
  forwardChat: ForwardChat;
  /** Override the owner store (tests). Defaults to the live module. */
  ownerStore?: OwnerStoreLike;
  /** Override the pending store (tests). Defaults to the live module. */
  pendingPermReqs?: PendingPermReqsLike;
}

/**
 * Build the `EmitVerdict` function.
 *
 * Returns a closure typed against `router.ts#EmitVerdict`. Wire into the
 * router from the entrypoint:
 *
 *   setEmitVerdict(makeEmitVerdict({ server, forwardChat }));
 *
 * Behaviour (plan §8 step 8b):
 *   - Owner-tuple miss → forward via `forwardChat(msg)`. NEVER emit verdict.
 *     Logged as `verdict_blocked_non_owner` so the operator can see an
 *     allowlisted-but-not-owner contact attempting to inject verdicts.
 *   - Owner-tuple hit → emit `notifications/claude/channel/permission` with
 *     `{ request_id, behavior: "allow" | "deny" }`, then consume the
 *     pending entry.
 *   - Notification failure → log `verdict_emit_failed` and STILL consume
 *     the pending entry (fail-closed: a half-failed verdict must not
 *     replay; the operator can re-issue from Claude if needed).
 */
export function makeEmitVerdict(deps: VerdictDeps): EmitVerdict {
  const ownerStore = deps.ownerStore ?? defaultOwnerStore;
  const pendingPermReqs = deps.pendingPermReqs ?? defaultPendingPermReqs;

  return async (
    id: string,
    allow: boolean,
    msg: InboundMsg,
  ): Promise<Action> => {
    // (1) Strict owner-tuple match. SYNC. Plan §8 step 7 + 8b.
    if (!ownerStore.matches(msg.from.contactId, msg.from.profileSha256)) {
      log.warn({
        evt: "verdict_blocked_non_owner",
        contact_id: msg.from.contactId,
        request_id: id,
      });
      return deps.forwardChat(msg);
    }

    // (2) Emit the verdict. The `notification` promise resolves once the
    // SDK has framed the JSON-RPC notification onto the transport — which
    // for stdio means the bytes are on fd 3. From this point the verdict
    // is durable from the channel's perspective.
    const behavior = allow ? "allow" : "deny";
    try {
      await deps.server.notification({
        method: PERMISSION_VERDICT_METHOD,
        params: { request_id: id, behavior },
      });
      log.info({
        evt: "verdict_emitted",
        request_id: id,
        behavior,
        contact_id: msg.from.contactId,
      });
    } catch (err) {
      // Fail-closed: consume the pending entry below so a stale
      // half-emitted verdict doesn't replay on the next inbound.
      log.error({
        evt: "verdict_emit_failed",
        request_id: id,
        behavior,
        error: String(err),
      });
    }

    // (3) Consume the pending entry. Single-use intent per plan: a
    // duplicate `yes <id>` from the owner now lands in the router with
    // `pending===undefined` and is forwarded as chat.
    pendingPermReqs.del(id);

    return { kind: "verdict", allow, id };
  };
}
