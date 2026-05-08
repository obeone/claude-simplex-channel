/**
 * `bind owner <RESCUECODE>` parser — v2 plan §8 step 5 genesis path.
 *
 * Any contact may submit a DM of the form `bind owner XXXXXXXX` (8-char
 * Crockford rescue code, case-insensitive whitespace tolerant). On match
 * against the bcrypt-hashed rescue code in `src/owner/store.ts`, the
 * sender's `(contactId, profileSha256)` tuple is promoted to owner.
 *
 * Contract — co-authored with worker-owner who owns `src/owner/store.ts`:
 *   - `verifyRescueCode(plain): Promise<boolean>` — bcrypt compare.
 *   - `bindOwner(contactId, profileSha256): Promise<void>` — sync cache update,
 *     async persist + rescue-code rotation (the rotation banner is what tells
 *     the operator a successful bind happened).
 *
 * The parser is the ONLY caller of `verifyRescueCode` outside the store.
 * The store itself never logs the plain code; we don't either.
 */
import * as ownerStore from "./store.js";
import type { CEvt, T } from "@simplex-chat/types";

import { log } from "../util/log.js";
import type { ChannelEventHub } from "../simplex/events.js";
import { profileSha256 } from "../channel/pairing.js";

/**
 * Regex matching the bind directive.
 *
 * - Leading `bind owner` is case-insensitive.
 * - Code group is `[A-Za-z0-9]{8}` (Crockford alphabet is uppercase, but we
 *   accept lower for operator convenience and uppercase before verifying).
 * - Trailing whitespace tolerated.
 *
 * NOTE: we do NOT match `[A-Z0-9]{8}` strictly here — the Crockford alphabet
 * for the rescue code excludes I/L/O/U, but the regex itself stays
 * permissive so a typo doesn't silently fall through to the channel router
 * as "looks like chat". A non-Crockford code will simply fail bcrypt
 * compare and be reported as an invalid bind attempt.
 */
export const BIND_RE = /^\s*bind\s+owner\s+([A-Za-z0-9]{8})\s*$/i;

/**
 * Outcome of attempting to bind.
 *
 * `kind=ignored` means the message text didn't match the bind pattern.
 * `kind=rejected` means the pattern matched but the code was wrong (or no
 * rescue code is loaded yet); the caller can log/notify but MUST NOT echo
 * the attempted code back to the sender (it might be a typo of a valid one).
 */
export type BindOutcome =
  | { kind: "ignored" }
  | { kind: "rejected"; reason: "bad_code" | "store_unloaded" }
  | { kind: "bound"; contactId: number; profileSha256: string };

export interface BindDeps {
  /** SimpleX channel event hub (subscribes to `newChatItems`). */
  events: ChannelEventHub;
  /** Test seam: override the verify call. */
  verifyRescueCode?: (plain: string) => Promise<boolean>;
  /** Test seam: override the bind call. */
  bindOwner?: (contactId: number, profileSha256: string) => Promise<void>;
  /** Test seam: pretend an owner is already bound (skip bind handling). */
  isOwnerBound?: () => boolean;
}

/**
 * Parse a single inbound text and apply the bind directive if present.
 *
 * Pure function over the deps — exposed for unit tests; the live wiring
 * via `installBindHandler` calls this for every direct inbound message.
 */
export async function tryBind(
  text: string,
  sender: T.Contact,
  deps: BindDeps,
): Promise<BindOutcome> {
  const match = BIND_RE.exec(text);
  if (!match) return { kind: "ignored" };

  const isBound =
    deps.isOwnerBound ??
    (() => ownerStore.getOwnerSnapshot().ownerContactId !== null);
  if (isBound()) {
    // Plan §8 step 5: genesis path is `bind owner` from any contact, but
    // ONLY when no owner exists. Once bound, re-binding requires
    // `clearOwnerSync()` first (PR 9 demotion). We refuse silently here
    // (don't disclose to the sender that an owner is already bound).
    log.warn({ evt: "bind_attempted_after_owner_bound" });
    return { kind: "rejected", reason: "bad_code" };
  }

  const candidate = match[1].toUpperCase();
  const verify = deps.verifyRescueCode ?? ownerStore.verifyRescueCode;
  const bind = deps.bindOwner ?? ownerStore.bindOwner;

  let ok: boolean;
  try {
    ok = await verify(candidate);
  } catch (err) {
    log.error({ evt: "bind_verify_threw", error: String(err) });
    return { kind: "rejected", reason: "store_unloaded" };
  }
  if (!ok) {
    log.warn({ evt: "bind_rejected_bad_code", contact_id: sender.contactId });
    return { kind: "rejected", reason: "bad_code" };
  }

  const sha = profileSha256(sender.profile);
  await bind(sender.contactId, sha);
  log.info({ evt: "bind_success", contact_id: sender.contactId });
  return { kind: "bound", contactId: sender.contactId, profileSha256: sha };
}

/**
 * Install the bind handler on the channel event hub.
 *
 * Iterates `newChatItems` and tries `tryBind` against each direct inbound
 * text. Ignored / rejected outcomes are silent to the sender (per plan:
 * never echo `meta.pair_code` or rescue code state). A successful bind is
 * surfaced via the owner store's rotation banner on stderr.
 */
export function installBindHandler(deps: BindDeps): void {
  deps.events.on("newChatItems", async (event: CEvt.NewChatItems) => {
    for (const ci of event.chatItems) {
      if (ci.chatInfo.type !== "direct") continue;
      const direction = ci.chatItem.chatDir;
      if (!direction || !direction.type?.startsWith("directRcv")) continue;
      const content = ci.chatItem.content;
      if (content.type !== "rcvMsgContent") continue;
      const msgContent = content.msgContent;
      if (msgContent.type !== "text") continue;
      await tryBind(msgContent.text, ci.chatInfo.contact, deps);
    }
  });
}
