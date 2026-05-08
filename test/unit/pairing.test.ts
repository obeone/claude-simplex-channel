/**
 * Unit tests for `src/channel/pairing.ts` and `src/owner/bind.ts`.
 *
 * Verbatim names per v2 plan §9:
 *   - `simultaneous_pair_codes_unique_per_connection`
 *
 * Plus supporting tests for the pieces every later PR depends on:
 * collision policy (PAIR_CODE_COLLISION reject-both), single-use semantics,
 * `tryBind()` rejection of bad codes, and `tryBind()` happy path.
 */
import { describe, expect, it } from "vitest";

import {
  Allowlist,
  PAIR_CODE_LEN,
  PAIR_CODE_RE,
  PairCodeStore,
} from "../../src/channel/pairing.js";
import { profileSha256 } from "../../src/util/profile-hash.js";
import { tryBind, BIND_RE } from "../../src/owner/bind.js";

describe("simultaneous_pair_codes_unique_per_connection", () => {
  it("mints a different code for each contact request when 1000 requests are queued back-to-back", () => {
    const store = new PairCodeStore();
    const codes = new Set<string>();
    let collisions = 0;
    for (let i = 0; i < 1000; i++) {
      const entry = store.mint(i);
      if (codes.has(entry.code)) collisions++;
      codes.add(entry.code);
      expect(entry.code).toMatch(PAIR_CODE_RE);
      expect(entry.code).toHaveLength(PAIR_CODE_LEN);
    }
    // 36^6 is roughly 2.18e9 so the chance of any collision in 1000 mints
    // is around 2e-4. We assert zero observed collisions in this run.
    expect(collisions).toBe(0);
    expect(store.size()).toBe(1000);
    for (let i = 0; i < 1000; i++) {
      const entry = store.peek(i);
      expect(entry).toBeDefined();
      expect(entry!.contactReqId).toBe(i);
    }
  });
});

describe("PairCodeStore", () => {
  it("rejects double-mint for the same contactReqId", () => {
    const store = new PairCodeStore();
    store.mint(1);
    expect(() => store.mint(1)).toThrow(/already minted/);
  });

  it("requires a connected contact before consume", () => {
    const store = new PairCodeStore();
    const entry = store.mint(1);
    expect(store.consume(entry.code)).toEqual({ kind: "miss" });
  });

  it("consumes single-use, then misses on replay", () => {
    const store = new PairCodeStore();
    const entry = store.mint(1);
    store.attachConnectedContact(1, fakeContact(7, "alice"));
    const first = store.consume(entry.code);
    expect(first.kind).toBe("consumed");
    const second = store.consume(entry.code);
    expect(second).toEqual({ kind: "miss" });
  });

  it("returns kind=collision and drops both entries when codes collide", () => {
    const store = new PairCodeStore();
    class FixedStore extends PairCodeStore {
      private fixed = "AAAAAA";
      // @ts-expect-error override private member for the test
      private randomCode(): string {
        return this.fixed;
      }
    }
    const fixed = new FixedStore();
    fixed.mint(1);
    fixed.mint(2);
    fixed.attachConnectedContact(1, fakeContact(11, "a"));
    fixed.attachConnectedContact(2, fakeContact(22, "b"));
    const result = fixed.consume("AAAAAA");
    expect(result).toEqual({ kind: "collision", code: "AAAAAA" });
    expect(fixed.size()).toBe(0);
    void store;
  });

  it("expires entries after TTL", () => {
    const store = new PairCodeStore();
    const start = 1_000_000;
    const entry = store.mint(1, start);
    store.attachConnectedContact(1, fakeContact(7, "alice"));
    expect(store.consume(entry.code, start + 1).kind).toBe("consumed");
    const entry2 = store.mint(2, start);
    store.attachConnectedContact(2, fakeContact(8, "bob"));
    expect(store.consume(entry2.code, start + 5 * 60 * 1000 + 1).kind).toBe(
      "miss",
    );
  });
});

describe("Allowlist", () => {
  it("admits and reports membership by (contactId, profileSha256)", () => {
    const a = new Allowlist();
    a.add({
      contactId: 7,
      profileSha256: "abc",
      admittedAt: new Date().toISOString(),
    });
    expect(a.has(7, "abc")).toBe(true);
    expect(a.has(7, "different")).toBe(false);
    expect(a.has(8, "abc")).toBe(false);
  });

  it("hasContactId() matches contactId regardless of profile sha", () => {
    const a = new Allowlist();
    a.add({
      contactId: 7,
      profileSha256: "abc",
      admittedAt: new Date().toISOString(),
    });
    expect(a.hasContactId(7)).toBe(true);
    expect(a.hasContactId(8)).toBe(false);
    const empty = new Allowlist();
    expect(empty.hasContactId(7)).toBe(false);
  });
});

describe("profileSha256", () => {
  it("ignores fields outside the canonical identity set", () => {
    const base = { displayName: "alice", fullName: "Alice", profileId: 1 };
    const same = { displayName: "alice", fullName: "Alice", profileId: 999 };
    const diff = { displayName: "alice", fullName: "ALICE" };
    expect(profileSha256(base as never)).toBe(profileSha256(same as never));
    expect(profileSha256(base as never)).not.toBe(profileSha256(diff as never));
  });
});

describe("BIND_RE / tryBind", () => {
  it("matches case-insensitive bind owner with whitespace", () => {
    const m = " Bind Owner ABCD1234 ".match(BIND_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("ABCD1234");
  });

  it("ignores unrelated chat", async () => {
    const result = await tryBind("hello there", fakeContact(1, "x"), {
      events: stubEvents(),
      isOwnerBound: () => false,
      verifyRescueCode: async () => true,
      bindOwner: async () => undefined,
    });
    expect(result.kind).toBe("ignored");
  });

  it("rejects when an owner is already bound (silent to sender)", async () => {
    const result = await tryBind(
      "bind owner ABCD1234",
      fakeContact(1, "x"),
      {
        events: stubEvents(),
        isOwnerBound: () => true,
        verifyRescueCode: async () => true,
        bindOwner: async () => undefined,
      },
    );
    expect(result).toEqual({ kind: "rejected", reason: "bad_code" });
  });

  it("rejects on bad code without leaking which part failed", async () => {
    const result = await tryBind(
      "bind owner WRONGAAA",
      fakeContact(1, "x"),
      {
        events: stubEvents(),
        isOwnerBound: () => false,
        verifyRescueCode: async () => false,
        bindOwner: async () => {
          throw new Error("bindOwner must not be called on bad code");
        },
      },
    );
    expect(result).toEqual({ kind: "rejected", reason: "bad_code" });
  });

  it("binds and returns the contact tuple on a good code", async () => {
    let bound: { contactId: number; sha: string } | undefined;
    const sender = fakeContact(42, "alice");
    const result = await tryBind(
      "bind owner ABCD1234",
      sender,
      {
        events: stubEvents(),
        isOwnerBound: () => false,
        verifyRescueCode: async (code) => code === "ABCD1234",
        bindOwner: async (contactId, sha) => {
          bound = { contactId, sha };
        },
      },
    );
    expect(result.kind).toBe("bound");
    if (result.kind === "bound") {
      expect(result.contactId).toBe(42);
      expect(result.profileSha256).toBe(profileSha256(sender.profile));
    }
    expect(bound?.contactId).toBe(42);
  });

  it("uppercases lowercase candidates before verifying", async () => {
    let seen: string | undefined;
    await tryBind("bind owner abcd1234", fakeContact(1, "x"), {
      events: stubEvents(),
      isOwnerBound: () => false,
      verifyRescueCode: async (code) => {
        seen = code;
        return false;
      },
      bindOwner: async () => undefined,
    });
    expect(seen).toBe("ABCD1234");
  });
});

// ----- helpers ---------------------------------------------------------

function fakeContact(contactId: number, displayName: string): never {
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

function stubEvents(): never {
  // Bind handlers are never installed in tryBind() unit tests; return a
  // stub that throws if .on() is called accidentally.
  return {
    on: () => {
      throw new Error("stubEvents.on() must not be called from tryBind unit tests");
    },
    off: () => {},
    emit: async () => {},
    clear: () => {},
  } as never;
}
