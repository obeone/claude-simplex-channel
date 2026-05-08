/**
 * Profile identity helper + ContactUpdated demotion handler.
 *
 * Per docs/plans/v2-claude-simplex-channel.md §7 (file layout) and §8 step 9.
 *
 * ## profileSha256
 *
 * Stable sha256 over the subset of `T.Profile` fields that constitute
 * identity. Used in two places downstream:
 *   - PR 4: owner-tuple match (`ownerStore.matches`).
 *   - PR 9: ContactUpdated demotion (this module).
 *
 * NOTE on duplication: `src/channel/pairing.ts` (worker-state, PR 5) defines
 * an identical helper. Both are kept in lock-step until a follow-up dedupes
 * them — both call sites MUST hash the same shape or the owner cache and
 * the allowlist will diverge after a re-import. If either drifts, the
 * `profile_change_demotes_to_allowlist_pending_rescue` test will catch the
 * regression because the bound owner sha would no longer match the freshly
 * computed sha for the same profile.
 *
 * ## installContactUpdatedDemotion
 *
 * Subscribes to the channel event hub's `contactUpdated` stream. On a
 * profile change for the bound owner, demotes synchronously and rotates
 * the rescue code in the background. Both halves matter:
 *
 *   - SYNCHRONOUS demotion (`ownerStore.clearOwnerSync()`) flips the cache
 *     on the SAME event-loop turn the event arrived. The next inbound
 *     message routed through `emitVerdict` MUST see a null owner — the
 *     attacker's profile-spoof window is closed before any new DM can
 *     reach the verdict gate.
 *
 *   - ASYNC rotation (`ownerStore.rotateAfterDemotion()`) mints + persists
 *     a new rescue code and prints the rotation banner on stderr. We do
 *     not await it here so the SimpleX event loop is not blocked by disk
 *     I/O. If rotation fails, the cache stays cleared (fail-closed); the
 *     operator can recover by deleting `owner.json` to force a genesis
 *     mint on next launch.
 */
import { createHash } from "node:crypto";
import type { CEvt, T } from "@simplex-chat/types";

import { log } from "../util/log.js";
import * as defaultOwnerStore from "../owner/store.js";
import type { ChannelEventHub } from "./events.js";

/**
 * Hash the subset of `T.Profile` fields that define identity.
 *
 * Excludes `profileId` (LocalProfile-only, not stable across re-imports).
 * The canonical shape is JSON-stringified in property order — `JSON.stringify`
 * iterates keys in insertion order, so we list them deterministically.
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

/**
 * Minimal owner-store surface the demotion handler depends on.
 *
 * Typed as `Pick`-like so tests can pass a stub without instantiating the
 * full module-singleton store.
 */
export interface DemotionOwnerStore {
  getOwnerSnapshot(): {
    ownerContactId: number | null;
    ownerProfileSha256: string | null;
  };
  clearOwnerSync(): void;
  rotateAfterDemotion(): Promise<void>;
}

/** Dependencies for `installContactUpdatedDemotion`. */
export interface DemotionDeps {
  events: ChannelEventHub;
  /** Override for tests; production uses the live owner-store module. */
  ownerStore?: DemotionOwnerStore;
  /** Override for tests; production uses `profileSha256`. */
  profileHash?: (profile: T.Profile | T.LocalProfile) => string;
  /**
   * Test seam: invoked once the background rotation settles (resolved or
   * rejected). Production code never sets this; tests use it to await
   * completion deterministically without poll-loops.
   */
  onRotationSettled?: (err: unknown | null) => void;
}

/**
 * Decide whether a `ContactUpdated` event should demote the bound owner.
 *
 * Pure function — exposed for unit tests. Returns `true` iff:
 *   1. There is a bound owner (`ownerContactId !== null`).
 *   2. The event's `toContact.contactId` matches the bound owner's contactId.
 *   3. `profileHash(toContact.profile) !== bound owner sha`.
 *
 * The `fromContact` / `toContact` distinction is preserved by SimpleX:
 *   `fromContact` is the prior state, `toContact` is the new state. We
 *   compare `toContact` because that is what every subsequent event will
 *   look like.
 */
export function shouldDemote(
  event: CEvt.ContactUpdated,
  ownerSnapshot: { ownerContactId: number | null; ownerProfileSha256: string | null },
  hash: (profile: T.Profile | T.LocalProfile) => string,
): boolean {
  if (ownerSnapshot.ownerContactId === null) return false;
  if (event.toContact.contactId !== ownerSnapshot.ownerContactId) return false;
  // Owner deleted (no profile sha persisted) but contact id matches: treat
  // as demotion-required (defensive — should not happen in practice since
  // a bound owner always has a sha; but a corrupted owner.json should not
  // silently allow a profile change to slip through).
  if (ownerSnapshot.ownerProfileSha256 === null) return true;
  return hash(event.toContact.profile) !== ownerSnapshot.ownerProfileSha256;
}

/**
 * Wire the ContactUpdated → demotion handler.
 *
 * Idempotent at the hub level: registering the same listener twice is a
 * no-op because `ChannelEventHub.on` uses a Set. Production code calls
 * this once from `src/index.ts` after `loadOwnerStore()` and after the
 * adapter is up.
 *
 * Behaviour:
 *   - Non-owner ContactUpdated (different contactId): ignored silently.
 *     This is the bulk of events on a normally-paired bot.
 *   - Owner ContactUpdated, same sha: ignored. Owner edited a non-identity
 *     field (e.g. an avatar bytes change that we DO include — see the
 *     canon shape — would still cause demotion; that's the intended
 *     conservative posture).
 *   - Owner ContactUpdated, new sha: SYNC `clearOwnerSync()`, then fire
 *     the async `rotateAfterDemotion()` in the background.
 */
export function installContactUpdatedDemotion(deps: DemotionDeps): void {
  const ownerStore = deps.ownerStore ?? defaultOwnerStore;
  const hash = deps.profileHash ?? profileSha256;

  deps.events.on("contactUpdated", (event) => {
    const snap = ownerStore.getOwnerSnapshot();
    if (!shouldDemote(event, snap, hash)) return;

    // SYNCHRONOUS demotion. The next emitVerdict() call after this turn
    // sees a null owner; the attacker's spoof window is closed before
    // any inbound DM can reach the verdict gate.
    ownerStore.clearOwnerSync();
    log.warn({
      evt: "owner_demoted_profile_change",
      contact_id: event.toContact.contactId,
    });

    // Background rotation: mint + persist + print the rotation banner.
    // Failures keep the cache cleared (fail-closed); the operator can
    // recover by deleting owner.json to force a genesis mint.
    void ownerStore
      .rotateAfterDemotion()
      .then(
        () => deps.onRotationSettled?.(null),
        (err: unknown) => {
          log.error({
            evt: "owner_demote_rotation_failed",
            contact_id: event.toContact.contactId,
            error: String(err),
          });
          deps.onRotationSettled?.(err);
        },
      );
  });
}
