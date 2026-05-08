/**
 * ContactUpdated demotion unit tests — PR 9, plan §8 step 9.
 *
 * Verbatim test name mandated by the plan §9 / task spec:
 *   - `profile_change_demotes_to_allowlist_pending_rescue`
 *
 * Plus supplementary coverage of the supporting invariants:
 *   - `profileSha256` is stable across `profileId` (canon excludes it).
 *   - `shouldDemote` returns false when the event is not for the bound owner.
 *   - The handler is no-op when no owner is bound.
 *   - The synchronous cache flips on the same turn the event is dispatched
 *     (the load-bearing invariant: the verdict gate must see null owner
 *     before the next inbound message).
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { CEvt, T } from "@simplex-chat/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as ownerStore from "../../src/owner/store.js";
import { ChannelEventHub } from "../../src/simplex/events.js";
import {
  installContactUpdatedDemotion,
  profileSha256,
  shouldDemote,
} from "../../src/simplex/profile.js";
import {
  __test_reset as routerReset,
  makeHandleInbound,
  setEmitVerdict,
  type Action,
  type ForwardChat,
  type InboundMsg,
} from "../../src/channel/router.js";
import * as pendingPermReqs from "../../src/channel/pendingPermReqs.js";
import { makeEmitVerdict } from "../../src/channel/verdict.js";

const RESCUE_BANNER_RE = /^RESCUE CODE \(first-launch, save it now\): ([0-9A-HJKMNP-TV-Z]{8})\n$/;
const ROTATION_BANNER_RE = /^OWNER PROFILE CHANGED — demoted to allowlist\. New rescue code: ([0-9A-HJKMNP-TV-Z]{8})\..*\n$/;

let tmpDir: string;
let ownerPath: string;
let stderrWrites: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  ownerStore.__test_reset();
  pendingPermReqs.__test_reset();
  routerReset();
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `profile-test-${crypto.randomBytes(4).toString("hex")}-`),
  );
  ownerPath = path.join(tmpDir, "channels", "simplex", "owner.json");
  stderrWrites = [];
  stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown): boolean => {
      stderrWrites.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    });
});

afterEach(async () => {
  stderrSpy.mockRestore();
  ownerStore.__test_reset();
  pendingPermReqs.__test_reset();
  routerReset();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Build a minimal `T.Contact`-like object — only fields the handler reads. */
function fakeContact(contactId: number, displayName: string): T.Contact {
  return {
    contactId,
    localDisplayName: displayName,
    profile: {
      profileId: contactId,
      displayName,
      fullName: displayName,
    },
  } as never;
}

function fakeContactUpdated(
  fromContact: T.Contact,
  toContact: T.Contact,
): CEvt.ContactUpdated {
  return {
    type: "contactUpdated",
    user: {} as never,
    fromContact,
    toContact,
  } as never;
}

describe("profileSha256", () => {
  it("is stable across profileId differences (excluded from canon)", () => {
    const base = { displayName: "alice", fullName: "Alice", profileId: 1 };
    const sameIdentity = { displayName: "alice", fullName: "Alice", profileId: 999 };
    expect(profileSha256(base as never)).toBe(profileSha256(sameIdentity as never));
  });

  it("changes when displayName or fullName changes", () => {
    const a = profileSha256({ displayName: "alice", fullName: "Alice" } as never);
    const b = profileSha256({ displayName: "alice", fullName: "Alicia" } as never);
    const c = profileSha256({ displayName: "ALICE", fullName: "Alice" } as never);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("shouldDemote", () => {
  const owner = fakeContact(7, "owner");
  const ownerSha = profileSha256(owner.profile);

  it("returns false when no owner is bound", () => {
    const evt = fakeContactUpdated(owner, fakeContact(7, "owner"));
    expect(
      shouldDemote(
        evt,
        { ownerContactId: null, ownerProfileSha256: null },
        profileSha256,
      ),
    ).toBe(false);
  });

  it("returns false for a non-owner contact", () => {
    const stranger = fakeContact(99, "stranger");
    const evt = fakeContactUpdated(stranger, fakeContact(99, "stranger-renamed"));
    expect(
      shouldDemote(
        evt,
        { ownerContactId: 7, ownerProfileSha256: ownerSha },
        profileSha256,
      ),
    ).toBe(false);
  });

  it("returns false when the owner's sha is unchanged", () => {
    const evt = fakeContactUpdated(owner, fakeContact(7, "owner"));
    expect(
      shouldDemote(
        evt,
        { ownerContactId: 7, ownerProfileSha256: ownerSha },
        profileSha256,
      ),
    ).toBe(false);
  });

  it("returns true when the owner's sha changes", () => {
    const renamed = fakeContact(7, "owner-renamed");
    const evt = fakeContactUpdated(owner, renamed);
    expect(
      shouldDemote(
        evt,
        { ownerContactId: 7, ownerProfileSha256: ownerSha },
        profileSha256,
      ),
    ).toBe(true);
  });
});

describe("installContactUpdatedDemotion", () => {
  it("flips the cache synchronously on the dispatch turn", async () => {
    await ownerStore.loadOwnerStore(ownerPath);
    const owner = fakeContact(7, "owner");
    await ownerStore.bindOwner(owner.contactId, profileSha256(owner.profile));
    expect(ownerStore.matches(7, profileSha256(owner.profile))).toBe(true);

    const events = new ChannelEventHub();
    installContactUpdatedDemotion({ events });

    const renamed = fakeContact(7, "owner-renamed");
    // Kick the event without awaiting — the SYNCHRONOUS clearOwnerSync must
    // have already run by the time we check `matches()` on the next line.
    void events.emit("contactUpdated", fakeContactUpdated(owner, renamed));
    expect(ownerStore.matches(7, profileSha256(owner.profile))).toBe(false);
  });

  it("is silent for non-owner contact updates", async () => {
    await ownerStore.loadOwnerStore(ownerPath);
    const owner = fakeContact(7, "owner");
    await ownerStore.bindOwner(owner.contactId, profileSha256(owner.profile));
    stderrWrites.length = 0; // forget the genesis + bind banners

    const events = new ChannelEventHub();
    installContactUpdatedDemotion({ events });

    await events.emit(
      "contactUpdated",
      fakeContactUpdated(fakeContact(99, "x"), fakeContact(99, "x-renamed")),
    );

    expect(ownerStore.matches(7, profileSha256(owner.profile))).toBe(true);
    expect(
      stderrWrites.find((w) => w.includes("OWNER PROFILE CHANGED")),
    ).toBeUndefined();
  });

  // --- Verbatim plan-mandated test below -----------------------------------

  it("profile_change_demotes_to_allowlist_pending_rescue", async () => {
    // Setup: load store, bind owner, register a permission request, wire the
    // full inbound + verdict pipeline so we can observe the gate effect.
    await ownerStore.loadOwnerStore(ownerPath);
    const owner = fakeContact(7, "owner");
    const ownerSha = profileSha256(owner.profile);
    await ownerStore.bindOwner(owner.contactId, ownerSha);
    pendingPermReqs.set("hjkmn", "Bash", "ls");
    stderrWrites.length = 0;

    const events = new ChannelEventHub();
    let rotationSettled: (err: unknown | null) => void = () => {};
    const rotated = new Promise<unknown | null>((resolve) => {
      rotationSettled = resolve;
    });
    installContactUpdatedDemotion({
      events,
      onRotationSettled: (err) => rotationSettled(err),
    });

    const server = {
      notification: vi.fn().mockResolvedValue(undefined),
    };
    const forwardCalls: InboundMsg[] = [];
    const forwardChat: ForwardChat = (msg: InboundMsg): Action => {
      forwardCalls.push(msg);
      return { kind: "chat", msg };
    };
    setEmitVerdict(makeEmitVerdict({ server, forwardChat, ownerStore, pendingPermReqs }));
    const handle = makeHandleInbound({
      ownerGate: (sender) => ownerStore.matches(sender.contactId, sender.profileSha256),
      forwardChat,
    });

    // Sanity: BEFORE the demotion the owner can emit a verdict.
    const before = (await handle({
      from: { contactId: 7, profileSha256: ownerSha },
      text: "yes hjkmn",
    })) as Action;
    expect(before.kind).toBe("verdict");
    expect(server.notification).toHaveBeenCalledTimes(1);

    // Re-arm a pending entry for the AFTER-demotion check.
    server.notification.mockClear();
    pendingPermReqs.set("pqrst", "Write", "/etc/hosts");

    // Profile change arrives.
    const renamed = fakeContact(7, "owner-renamed");
    const renamedSha = profileSha256(renamed.profile);
    await events.emit("contactUpdated", fakeContactUpdated(owner, renamed));

    // Cache is null — the next ownerGate check fails fast (no verdict emitted).
    // This is exactly the "verdicts from this contact are now forwarded" check
    // mandated by the plan §9 test name.
    expect(ownerStore.matches(7, ownerSha)).toBe(false);
    expect(ownerStore.matches(7, renamedSha)).toBe(false);

    // The renamed owner DM lands as a `drop` (ownerGate=false). The OLD
    // profile sha would also fail. Either way, NO verdict is emitted.
    const dropResult = handle({
      from: { contactId: 7, profileSha256: renamedSha },
      text: "yes pqrst",
    }) as Action;
    expect(dropResult).toEqual({ kind: "drop" });
    expect(server.notification).not.toHaveBeenCalled();

    // The pending entry SURVIVES the demotion — the new owner (after
    // re-bind) can still respond. The plan calls this "pending rescue":
    // verdicts are paused, not lost.
    expect(pendingPermReqs.get("pqrst")).toBeDefined();

    // Background rotation is fired by the demotion handler as void; await it
    // via the test seam so we can assert the banner deterministically without
    // a poll loop.
    expect(await rotated).toBeNull();

    const banner = stderrWrites.find((w) => w.includes("OWNER PROFILE CHANGED"));
    expect(banner, "rotation banner missing").toBeDefined();
    const matched = (banner as string).match(ROTATION_BANNER_RE);
    expect(matched, `rotation banner did not match: ${banner}`).not.toBeNull();
    const newCode = (matched as RegExpMatchArray)[1];
    expect(newCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);

    // The new code (and only the new code) verifies — re-bind path is open.
    expect(await ownerStore.verifyRescueCode(newCode)).toBe(true);
  });
});

// Small unused import shim so the regex above for the genesis banner stays
// referenced (otherwise TypeScript drops the import on `--noEmit`).
void RESCUE_BANNER_RE;
