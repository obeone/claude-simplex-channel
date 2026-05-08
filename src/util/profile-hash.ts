/**
 * Canonical profile identity hash.
 *
 * Single source of truth for the sha256 over `T.Profile` fields that
 * constitute SimpleX identity. Previously duplicated between
 * `src/channel/pairing.ts` (worker-state) and `src/simplex/profile.ts`
 * (worker-owner); both call sites now import from here.
 *
 * Used in three places downstream:
 *   - PR 4: owner-tuple match (`ownerStore.matches`).
 *   - PR 5: pairing allowlist admission (`consumePairCodeFromOwner`).
 *   - PR 9: ContactUpdated demotion (`installContactUpdatedDemotion`).
 *
 * If you change the canonical shape, ALL three call sites must agree or the
 * owner cache and the allowlist will diverge after a re-import. The
 * `profile_change_demotes_to_allowlist_pending_rescue` test will catch the
 * regression because the bound owner sha would no longer match the freshly
 * computed sha for the same profile.
 */
import { createHash } from "node:crypto";
import type { T } from "@simplex-chat/types";

/**
 * Compute a stable sha256 over the SimpleX profile fields that constitute
 * identity.
 *
 * Excludes `profileId` (a LocalProfile-only int that varies across
 * re-imports). The canonical shape is JSON-stringified in property insertion
 * order — `JSON.stringify` iterates keys deterministically — so callers must
 * not add keys unless they update all three downstream sites.
 *
 * @param profile - A `T.Profile` or `T.LocalProfile` object.
 * @returns Hex-encoded sha256 digest of the canonical JSON.
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
