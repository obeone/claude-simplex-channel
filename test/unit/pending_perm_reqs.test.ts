/**
 * pendingPermReqs unit tests — PR 7, plan §8 step 7.
 *
 * Verbatim test name mandated by the task spec:
 *   - pending_perm_reqs_ttl_expires
 *
 * Plus supplementary coverage of the load-bearing invariants:
 *   - id is stored lowercased; lookup is case-insensitive
 *   - get() returns undefined for an entry past its expiresAt before sweep runs
 *   - sweepExpired() removes only the dead entries
 *   - del() is idempotent
 *   - startSweep() is idempotent
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as pending from "../../src/channel/pendingPermReqs.js";

beforeEach(() => {
  pending.__test_reset();
});

afterEach(() => {
  pending.__test_reset();
  vi.useRealTimers();
});

describe("pendingPermReqs", () => {
  it("stores entries under a lowercased key and preserves original-case requestId", () => {
    pending.set("ABCDE", "Bash", "ls -la", 1_000);
    expect(pending.size()).toBe(1);

    const hit = pending.get("abcde", 1_001);
    expect(hit).toBeDefined();
    expect(hit!.requestId).toBe("ABCDE");
    expect(hit!.toolName).toBe("Bash");
    expect(hit!.description).toBe("ls -la");

    // Mixed case lookup also hits.
    const mixed = pending.get("AbCdE", 1_001);
    expect(mixed).toBeDefined();
    expect(mixed!.requestId).toBe("ABCDE");
  });

  it("returns undefined for an unknown id", () => {
    pending.set("aaaaa", "Bash", "");
    expect(pending.get("zzzzz")).toBeUndefined();
  });

  it("pending_perm_reqs_ttl_expires", () => {
    const now = 1_000_000;
    pending.set("ttl1", "Bash", "rm -rf", now);
    // Within TTL.
    expect(pending.get("ttl1", now + 1)).toBeDefined();
    // Just before TTL boundary.
    expect(
      pending.get("ttl1", now + pending.PENDING_TTL_MS - 1),
    ).toBeDefined();
    // At TTL boundary — the entry is dead (expiresAt is exclusive of "still alive").
    expect(pending.get("ttl1", now + pending.PENDING_TTL_MS)).toBeUndefined();
    // After TTL.
    expect(
      pending.get("ttl1", now + pending.PENDING_TTL_MS + 1),
    ).toBeUndefined();

    // Sweep removes the dead entry from the map.
    expect(pending.size()).toBe(1);
    const removed = pending.sweepExpired(now + pending.PENDING_TTL_MS + 1);
    expect(removed).toBe(1);
    expect(pending.size()).toBe(0);
  });

  it("sweepExpired removes only the dead entries", () => {
    const now = 1_000_000;
    pending.set("alive", "Bash", "", now);
    pending.set("dead", "Bash", "", now - pending.PENDING_TTL_MS);

    expect(pending.size()).toBe(2);
    const removed = pending.sweepExpired(now);
    expect(removed).toBe(1);
    expect(pending.size()).toBe(1);
    expect(pending.get("alive", now)).toBeDefined();
    expect(pending.get("dead", now)).toBeUndefined();
  });

  it("del removes an entry and is idempotent for unknown ids", () => {
    pending.set("xxxxx", "Bash", "");
    pending.del("XXXXX");
    expect(pending.size()).toBe(0);
    // Idempotent.
    expect(() => pending.del("never-was-here")).not.toThrow();
  });

  it("startSweep is idempotent and the timer is unref'd", () => {
    vi.useFakeTimers();
    pending.startSweep(50);
    pending.startSweep(50);

    pending.set("dead", "Bash", "", Date.now() - pending.PENDING_TTL_MS);
    expect(pending.size()).toBe(1);

    vi.advanceTimersByTime(60);
    expect(pending.size()).toBe(0);

    pending.stopSweep();
  });
});
