/**
 * Pairing protocol — v2 plan §8 step 5 (S4: NO MCP tool).
 *
 * The pairing flow has two paths:
 *
 *   1. Owner-driven (default): a SimpleX phone DMs the bot →
 *      `ReceivedContactRequest` event → bot mints a 6-char pair code, accepts
 *      the contact, then on `ContactConnected` DMs the new contact the code.
 *      The OPERATOR (current owner) reads the code from a side-channel and
 *      DMs it back from the owner contact. On `NewChatItems` from owner with
 *      body matching `^[A-Z0-9]{6}$` we look up the code, mark it consumed,
 *      and add the originating connection's tuple to the allowlist.
 *
 *   2. Genesis: when no owner is bound yet, the only commit path is
 *      `bind owner <RESCUECODE>` from any contact (handled by
 *      `src/owner/bind.ts`).
 *
 * Collision policy (verbatim from plan):
 *     "If 2 outstanding pairCode collide, reject both with stderr
 *     PAIR_CODE_COLLISION code=XXXXXX consumed=both, emit
 *     notifications/claude/channel with meta.kind=pairing_collision."
 *
 * MCP coupling: this module accepts a `notify(method, params)` callback so it
 * does not import the McpServer directly — keeps the pairing layer testable
 * without an MCP transport, and decoupled from worker-mcp's namespace.
 */
import { createHash, randomInt } from "node:crypto";
import type { ChatApi } from "simplex-chat/dist/api.js";
import { T, type CEvt } from "@simplex-chat/types";

import { log } from "../util/log.js";
import type { ChannelEventHub } from "../simplex/events.js";

/** TTL for an outstanding pair code (5 minutes per plan). */
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
/** Pair code length per plan; 6 characters. */
export const PAIR_CODE_LEN = 6;
/** Alphabet: uppercase letters + digits, no Crockford ambiguity-trim — plan
 *  literally says `^[A-Z0-9]{6}$` so we honour the full 36-char set. */
const PAIR_CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Inbound regex per plan §8 step 5. */
export const PAIR_CODE_RE = /^[A-Z0-9]{6}$/;

/**
 * Bookkeeping for an outstanding pair code.
 *
 * `contactReqId`: SimpleX side identifier of the inbound request that triggered
 *                 the mint. Bound 1:1 — single-use per contactReqId.
 * `expiresAt`:    Unix epoch ms. Lookup rejects expired codes silently.
 * `connectedContact`: filled in on the matching `contactConnected` event
 *                     (after `apiAcceptContactRequest` resolves). Until that
 *                     happens the entry exists but cannot be consumed.
 */
interface PairCodeEntry {
  code: string;
  contactReqId: number;
  expiresAt: number;
  /** Set once we've observed `contactConnected` for this contact. */
  connectedContact?: T.Contact;
}

/** MCP notification surface — stays tiny on purpose. */
export type ChannelNotifier = (
  method: string,
  params: Record<string, unknown>,
) => void | Promise<void>;

/** Allowlist entry. Coarse — the strict owner check lives in owner/store.ts. */
export interface AllowlistEntry {
  contactId: number;
  profileSha256: string;
  /** Code that admitted the contact (for diagnostics; never logged plain). */
  viaPairCode?: string;
  /** When the contact was admitted (ISO). */
  admittedAt: string;
}

/**
 * In-memory pair-code store.
 *
 * Two indices:
 *   - byContactReqId: lookup on `contactConnected`/expiry sweep
 *   - byCode: lookup on inbound `^[A-Z0-9]{6}$` body (collision-aware)
 *
 * `byCode` maps `code → contactReqId[]`. A code with `length>1` is an active
 * collision and is rejected (both sides) per plan §8 step 5.
 */
export class PairCodeStore {
  private readonly byContactReqId = new Map<number, PairCodeEntry>();
  private readonly byCode = new Map<string, number[]>();

  /** Mint a fresh code for a contact request. Returns the entry minted. */
  mint(contactReqId: number, now: number = Date.now()): PairCodeEntry {
    if (this.byContactReqId.has(contactReqId)) {
      throw new Error(
        `pair code already minted for contactReqId=${contactReqId}`,
      );
    }
    const code = this.randomCode();
    const entry: PairCodeEntry = {
      code,
      contactReqId,
      expiresAt: now + PAIR_CODE_TTL_MS,
    };
    this.byContactReqId.set(contactReqId, entry);
    const existing = this.byCode.get(code);
    if (existing) {
      existing.push(contactReqId);
    } else {
      this.byCode.set(code, [contactReqId]);
    }
    return entry;
  }

  /** Mark the contact as connected so the entry can be consumed. */
  attachConnectedContact(contactReqId: number, contact: T.Contact): void {
    const entry = this.byContactReqId.get(contactReqId);
    if (entry) entry.connectedContact = contact;
  }

  /**
   * Look up a code submitted by the owner. Returns:
   *   - { kind: 'consumed', entry } on a clean single-match consumption
   *   - { kind: 'collision', code } when 2+ outstanding entries share the
   *     code (plan-mandated reject-both behaviour: BOTH entries are dropped
   *     and the caller logs `PAIR_CODE_COLLISION code=XXXXXX consumed=both`)
   *   - { kind: 'miss' } when the code is unknown or expired
   *
   * Single-use: a successful match removes the entry from both indices
   * before returning, so the same code cannot be replayed.
   */
  consume(
    code: string,
    now: number = Date.now(),
  ):
    | { kind: "consumed"; entry: PairCodeEntry }
    | { kind: "collision"; code: string }
    | { kind: "miss" } {
    const reqIds = this.byCode.get(code);
    if (!reqIds || reqIds.length === 0) return { kind: "miss" };
    if (reqIds.length > 1) {
      // Plan: reject both. Drop every entry sharing this code.
      for (const reqId of reqIds) this.byContactReqId.delete(reqId);
      this.byCode.delete(code);
      return { kind: "collision", code };
    }
    const entry = this.byContactReqId.get(reqIds[0]);
    if (!entry || entry.expiresAt <= now) {
      this.dropByContactReqId(reqIds[0]);
      return { kind: "miss" };
    }
    if (!entry.connectedContact) {
      // Code exists but contact hasn't connected yet — owner DMing too early.
      return { kind: "miss" };
    }
    this.dropByContactReqId(entry.contactReqId);
    return { kind: "consumed", entry };
  }

  /** Drop expired entries (sweep). Returns count removed. */
  sweepExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [reqId, entry] of this.byContactReqId) {
      if (entry.expiresAt <= now) {
        this.dropByContactReqId(reqId);
        removed++;
      }
    }
    return removed;
  }

  /** Drop the entry tied to a specific contactReqId. */
  dropByContactReqId(contactReqId: number): void {
    const entry = this.byContactReqId.get(contactReqId);
    if (!entry) return;
    this.byContactReqId.delete(contactReqId);
    const ids = this.byCode.get(entry.code);
    if (!ids) return;
    const remaining = ids.filter((id) => id !== contactReqId);
    if (remaining.length === 0) this.byCode.delete(entry.code);
    else this.byCode.set(entry.code, remaining);
  }

  /** Test/diagnostic: number of live entries. */
  size(): number {
    return this.byContactReqId.size;
  }

  /** Test/diagnostic: read entry by contactReqId. */
  peek(contactReqId: number): PairCodeEntry | undefined {
    return this.byContactReqId.get(contactReqId);
  }

  /**
   * Generate a random 6-char `[A-Z0-9]` code via crypto.randomInt for
   * uniform distribution across the alphabet.
   */
  private randomCode(): string {
    let out = "";
    for (let i = 0; i < PAIR_CODE_LEN; i++) {
      out += PAIR_CODE_ALPHABET[randomInt(0, PAIR_CODE_ALPHABET.length)];
    }
    return out;
  }
}

/**
 * In-memory allowlist of admitted (non-owner) contact tuples.
 *
 * The strict owner check still lives in `src/owner/store.ts`; this
 * allowlist is the coarse gate from plan §8 step 8a (`ownerGate`). For PR 5
 * the only writer is `consumePairCodeFromOwner` after a successful match.
 *
 * No persistence in v1: a process restart re-pairs from scratch (acceptable
 * trade-off; the rescue code path remains).
 */
export class Allowlist {
  private readonly entries = new Map<string, AllowlistEntry>();

  private static key(contactId: number, profileSha256: string): string {
    return `${contactId}:${profileSha256}`;
  }

  add(entry: AllowlistEntry): void {
    this.entries.set(Allowlist.key(entry.contactId, entry.profileSha256), entry);
  }

  has(contactId: number, profileSha256: string): boolean {
    return this.entries.has(Allowlist.key(contactId, profileSha256));
  }

  size(): number {
    return this.entries.size;
  }

  remove(contactId: number, profileSha256: string): void {
    this.entries.delete(Allowlist.key(contactId, profileSha256));
  }
}

/**
 * Compute a stable sha256 over the SimpleX profile fields that constitute
 * identity. We exclude `profileId` (a LocalProfile-only int that varies
 * across re-imports) and any non-deterministic ordering by hashing a
 * canonicalised JSON.
 *
 * NOTE: this hash is used in two places downstream — the owner-tuple
 * compare (PR 4) and `ContactUpdated` demotion (PR 9). All three must agree
 * on the input shape; if you change this function, audit those call sites.
 */
export function profileSha256(profile: T.Profile | T.LocalProfile): string {
  const canon = {
    displayName: profile.displayName,
    fullName: profile.fullName,
    shortDescr: profile.shortDescr ?? null,
    image: profile.image ?? null,
    contactLink: profile.contactLink ?? null,
    peerType: profile.peerType ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

/** Configuration for `installPairingHandlers`. */
export interface PairingDeps {
  api: ChatApi;
  events: ChannelEventHub;
  store: PairCodeStore;
  allowlist: Allowlist;
  notify: ChannelNotifier;
  /**
   * Synchronous owner-tuple matcher. Defaults to importing
   * `src/owner/store.ts#matches` lazily so unit tests can swap a stub.
   */
  ownerMatches?: (contactId: number, profileSha256: string) => boolean;
}

/**
 * Wire the pairing event handlers onto the channel event hub.
 *
 * Side effects:
 *   - On `receivedContactRequest`: mint code, call `apiAcceptContactRequest`.
 *   - On `contactConnected`: bind connected contact to the entry, DM the
 *     code to the new contact, emit `pairing_prompt` MCP notification.
 *   - On `newChatItems` whose author matches `ownerMatches` and body matches
 *     `PAIR_CODE_RE`: consume the code and add the originating tuple to
 *     allowlist; on collision, log + emit `pairing_collision`.
 */
export function installPairingHandlers(deps: PairingDeps): void {
  const { api, events, store, allowlist, notify } = deps;
  const ownerMatches =
    deps.ownerMatches ??
    ((contactId: number, sha: string): boolean => {
      // Lazy import to keep the pairing module testable without owner store.
      // Eagerly require would couple module load order; we accept the small
      // cost of a require lookup per inbound msg (Node caches it).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const store = require("../owner/store.js") as typeof import("../owner/store.js");
      return store.matches(contactId, sha);
    });

  events.on("receivedContactRequest", async (event: CEvt.ReceivedContactRequest) => {
    const reqId = event.contactRequest.contactRequestId;
    let entry: PairCodeEntry;
    try {
      entry = store.mint(reqId);
    } catch (err) {
      log.warn({ evt: "pair_mint_skipped", contact_req_id: reqId, reason: String(err) });
      return;
    }
    log.info({ evt: "pair_code_minted", contact_req_id: reqId });
    try {
      await api.apiAcceptContactRequest(reqId);
    } catch (err) {
      log.error({
        evt: "accept_contact_failed",
        contact_req_id: reqId,
        error: String(err),
      });
      store.dropByContactReqId(reqId);
      return;
    }
    // Note: no notification yet — we wait until contactConnected so Claude
    // sees a single "pairing_prompt" with the actual contact id, not an
    // intermediate "request received" event.
    void entry;
  });

  events.on("contactConnected", async (event: CEvt.ContactConnected) => {
    const contact = event.contact;
    const reqId = contact.contactRequestId;
    if (reqId === undefined) {
      // Connection wasn't from one of our pair-code mints (e.g., an
      // existing contact reconnecting). Nothing for the pairing layer.
      return;
    }
    const entry = store.peek(reqId);
    if (!entry) {
      log.warn({ evt: "pair_code_missing_on_connect", contact_req_id: reqId });
      return;
    }
    store.attachConnectedContact(reqId, contact);
    const text =
      `Pairing code: ${entry.code}. Have the operator DM this code back from ` +
      `their owner contact within 5 minutes.`;
    try {
      await api.apiSendTextMessage([T.ChatType.Direct, contact.contactId], text);
    } catch (err) {
      log.error({
        evt: "pair_dm_failed",
        contact_id: contact.contactId,
        error: String(err),
      });
    }
    await notify("notifications/claude/channel", {
      meta: {
        kind: "pairing_prompt",
        // Plan §8 step 5: pair_code carried in MCP meta (informational).
        // The instructions string forbids Claude from echoing it via reply.
        pair_code: entry.code,
        contact_id: contact.contactId,
      },
    });
    log.info({ evt: "pair_prompt_sent", contact_id: contact.contactId });
  });

  events.on("newChatItems", async (event: CEvt.NewChatItems) => {
    for (const ci of event.chatItems) {
      // We only care about direct inbound messages from a contact.
      if (ci.chatInfo.type !== "direct") continue;
      const direction = ci.chatItem.chatDir;
      if (!direction || !direction.type?.startsWith("directRcv")) continue;
      const content = ci.chatItem.content;
      if (content.type !== "rcvMsgContent") continue;
      const msgContent = content.msgContent;
      if (msgContent.type !== "text") continue;
      const text = msgContent.text.trim();
      if (!PAIR_CODE_RE.test(text)) continue;

      const sender = ci.chatInfo.contact;
      const senderSha = profileSha256(sender.profile);
      if (!ownerMatches(sender.contactId, senderSha)) {
        // Non-owner just typed something matching the regex; not a verdict.
        // Per S4 the only commit path that owner-promotes is `bind owner`
        // (handled by src/owner/bind.ts). Drop silently.
        continue;
      }

      const result = store.consume(text);
      if (result.kind === "miss") {
        log.info({ evt: "pair_code_unknown_from_owner" });
        continue;
      }
      if (result.kind === "collision") {
        process.stderr.write(
          `PAIR_CODE_COLLISION code=${result.code} consumed=both\n`,
        );
        log.warn({ evt: "pair_code_collision", code: result.code });
        await notify("notifications/claude/channel", {
          meta: { kind: "pairing_collision", code: result.code },
        });
        continue;
      }
      // Consumed: add the connected contact's tuple to the allowlist.
      const admitted = result.entry.connectedContact;
      if (!admitted) {
        log.warn({ evt: "pair_consumed_without_contact" });
        continue;
      }
      const sha = profileSha256(admitted.profile);
      allowlist.add({
        contactId: admitted.contactId,
        profileSha256: sha,
        viaPairCode: result.entry.code,
        admittedAt: new Date().toISOString(),
      });
      log.info({
        evt: "pair_admitted",
        contact_id: admitted.contactId,
      });
      await notify("notifications/claude/channel", {
        meta: {
          kind: "pairing_admitted",
          contact_id: admitted.contactId,
        },
      });
    }
  });
}
