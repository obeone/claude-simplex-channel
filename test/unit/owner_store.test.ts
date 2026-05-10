/**
 * Owner store unit tests — PR 4, plan §8 step 4 + §9.
 *
 * Verbatim test names mandated by the plan:
 *   - `incognito_repair_does_not_grant_owner`
 *   - `db_wipe_then_repair_requires_rescue_code`
 *
 * Plus supplementary coverage of the load-bearing invariants:
 *   - rescue code is exactly 8 Crockford-base32 chars
 *   - owner.json is mode 0600
 *   - rescue code is printed on stderr exactly once on first launch
 *   - `verifyRescueCode` round-trips against the printed code
 *   - `matches()` is sync and returns false until `bindOwner` runs
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __test_reset,
  __test_setReloadDebounceMs,
  bindOwner,
  clearOwnerSync,
  defaultOwnerFilePath,
  getOwnerSnapshot,
  loadOwnerStore,
  matches,
  reloadOwnerStore,
  rotateAfterDemotion,
  rotateRescueCodeOnly,
  startOwnerStoreWatcher,
  stopOwnerStoreWatcher,
  verifyRescueCode,
} from "../../src/owner/store.js";

const CROCKFORD_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const RESCUE_BANNER_RE = /^RESCUE CODE \(first-launch, save it now\): ([0-9A-HJKMNP-TV-Z]{8})\n$/;
const ROTATION_BANNER_RE = /^OWNER PROFILE CHANGED .* New rescue code: ([0-9A-HJKMNP-TV-Z]{8})\..*\n$/;

let tmpDir: string;
let ownerPath: string;
/** Captures every `process.stderr.write` call during a single test. */
let stderrWrites: string[];
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  __test_reset();
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `owner-store-test-${crypto.randomBytes(4).toString("hex")}-`),
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
  __test_reset();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Pull the rescue code out of the captured first-launch stderr banner. */
function captureRescueCode(): string {
  const banners = stderrWrites.filter((w) => w.startsWith("RESCUE CODE"));
  expect(banners).toHaveLength(1);
  const matched = banners[0].match(RESCUE_BANNER_RE);
  expect(matched, `banner did not match: ${banners[0]}`).not.toBeNull();
  return (matched as RegExpMatchArray)[1];
}

describe("owner store", () => {
  it("defaults to ~/.claude/channels/simplex/owner.json", () => {
    expect(defaultOwnerFilePath()).toBe(
      path.join(os.homedir(), ".claude", "channels", "simplex", "owner.json"),
    );
  });

  it("mints an 8-char Crockford rescue code on first launch and prints it once on stderr", async () => {
    await loadOwnerStore(ownerPath);
    const code = captureRescueCode();
    expect(code).toMatch(CROCKFORD_RE);
    // Exactly one stderr write — the banner — for first launch.
    expect(stderrWrites.filter((w) => w.includes("RESCUE CODE"))).toHaveLength(1);
  });

  it("persists owner.json with mode 0600 and the bcrypt hash", async () => {
    await loadOwnerStore(ownerPath);
    const stat = await fs.stat(ownerPath);
    // Mask off the type bits, keep just permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
    const raw = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    expect(raw.ownerContactId).toBeNull();
    expect(raw.ownerProfileSha256).toBeNull();
    expect(typeof raw.createdAt).toBe("string");
    expect(raw.rescueCodeHash).toMatch(/^\$2[aby]\$12\$/);
  });

  it("does NOT print the rescue code again on a second launch", async () => {
    await loadOwnerStore(ownerPath);
    captureRescueCode(); // sanity check — first launch printed.
    stderrWrites.length = 0;

    __test_reset();
    await loadOwnerStore(ownerPath);
    expect(stderrWrites.filter((w) => w.includes("RESCUE CODE"))).toHaveLength(0);
  });

  it("verifyRescueCode accepts the printed code and rejects garbage", async () => {
    await loadOwnerStore(ownerPath);
    const code = captureRescueCode();
    expect(await verifyRescueCode(code)).toBe(true);
    expect(await verifyRescueCode("00000000")).toBe(false);
    expect(await verifyRescueCode(code + "X")).toBe(false);
  });

  it("matches() returns false before bindOwner runs (genesis)", async () => {
    await loadOwnerStore(ownerPath);
    expect(matches(42, "a".repeat(64))).toBe(false);
    expect(getOwnerSnapshot()).toEqual({
      ownerContactId: null,
      ownerProfileSha256: null,
    });
  });

  it("matches() returns true synchronously after bindOwner", async () => {
    await loadOwnerStore(ownerPath);
    const sha = "b".repeat(64);
    await bindOwner(7, sha);
    // Synchronous check — no await on the call site.
    expect(matches(7, sha)).toBe(true);
    expect(matches(8, sha)).toBe(false);
    expect(matches(7, "c".repeat(64))).toBe(false);
  });

  it("clearOwnerSync flips matches() to false on the same turn", async () => {
    await loadOwnerStore(ownerPath);
    const sha = "d".repeat(64);
    await bindOwner(11, sha);
    expect(matches(11, sha)).toBe(true);
    clearOwnerSync();
    expect(matches(11, sha)).toBe(false);
  });

  it("rotateAfterDemotion mints a fresh code and prints rotation banner", async () => {
    await loadOwnerStore(ownerPath);
    captureRescueCode();
    stderrWrites.length = 0;

    await rotateAfterDemotion();
    const rotation = stderrWrites.find((w) => w.includes("OWNER PROFILE CHANGED"));
    expect(rotation, "rotation banner missing").toBeDefined();
    const matched = (rotation as string).match(ROTATION_BANNER_RE);
    expect(matched, `rotation banner did not match: ${rotation}`).not.toBeNull();
    const newCode = (matched as RegExpMatchArray)[1];
    expect(newCode).toMatch(CROCKFORD_RE);
    expect(await verifyRescueCode(newCode)).toBe(true);
  });

  it("rotateRescueCodeOnly preserves the bound owner and rotates the code", async () => {
    await loadOwnerStore(ownerPath);
    const firstCode = captureRescueCode();
    const sha = "8".repeat(64);
    await bindOwner(321, sha);
    expect(matches(321, sha)).toBe(true);
    stderrWrites.length = 0;

    // Bind already rotated once — clear and rotate again via the new path.
    await rotateRescueCodeOnly();

    // Owner stays bound.
    expect(matches(321, sha)).toBe(true);
    // Banner uses the same rotation format.
    const rotation = stderrWrites.find((w) => w.includes("New rescue code"));
    expect(rotation, "rotation banner missing").toBeDefined();
    const m = (rotation as string).match(ROTATION_BANNER_RE);
    expect(m, `rotation banner did not match: ${rotation}`).not.toBeNull();
    const rotated = (m as RegExpMatchArray)[1];
    expect(rotated).toMatch(CROCKFORD_RE);
    expect(rotated).not.toBe(firstCode);
    expect(await verifyRescueCode(rotated)).toBe(true);

    // The on-disk record reflects both: owner still bound, new hash.
    const raw = JSON.parse(await fs.readFile(ownerPath, "utf8"));
    expect(raw.ownerContactId).toBe(321);
    expect(raw.ownerProfileSha256).toBe(sha);
  });

  // --- Verbatim plan-mandated tests below -----------------------------------

  it("incognito_repair_does_not_grant_owner", async () => {
    // Genesis: owner.json minted, ownerContactId is null.
    await loadOwnerStore(ownerPath);
    captureRescueCode();

    // Simulate an incognito reconnect: a brand-new contactId arrives with
    // a freshly-rolled profile sha. Without a successful `bind owner`,
    // `matches()` MUST stay false — the router uses this as the verdict gate.
    const incognitoContact = 99;
    const incognitoSha = crypto.randomBytes(32).toString("hex");
    expect(matches(incognitoContact, incognitoSha)).toBe(false);

    // Even after several inbound events (still no rescue code presented),
    // the cache must remain unbound.
    for (let i = 0; i < 5; i += 1) {
      expect(
        matches(incognitoContact + i, crypto.randomBytes(32).toString("hex")),
      ).toBe(false);
    }
    expect(getOwnerSnapshot().ownerContactId).toBeNull();
  });

  // --- Hot-reload tests --------------------------------------------------

  /** Sleep helper for tests racing fs.watch debouncing. */
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  it("reloadOwnerStore picks up an external bind without reloading the module", async () => {
    await loadOwnerStore(ownerPath);
    expect(getOwnerSnapshot().ownerContactId).toBeNull();

    // Simulate another process binding by writing owner.json directly.
    const sha = "f".repeat(64);
    const newRecord = {
      ownerContactId: 555,
      ownerProfileSha256: sha,
      createdAt: new Date().toISOString(),
      // Use a fresh bcrypt hash so verifyRescueCode after reload returns
      // false for the old code (which we don't even know — file was minted
      // by a hypothetical other process).
      rescueCodeHash:
        "$2b$12$0123456789012345678901uG5VzZGmI8kT0IEvB.XR5J0M0cWfwYyu",
    };
    await fs.writeFile(ownerPath, JSON.stringify(newRecord, null, 2) + "\n", {
      mode: 0o600,
    });

    await reloadOwnerStore();
    expect(getOwnerSnapshot()).toEqual({
      ownerContactId: 555,
      ownerProfileSha256: sha,
    });
    expect(matches(555, sha)).toBe(true);
  });

  it("reloadOwnerStore resets to unbound when the file disappears", async () => {
    await loadOwnerStore(ownerPath);
    captureRescueCode();
    const sha = "a".repeat(64);
    await bindOwner(42, sha);
    expect(matches(42, sha)).toBe(true);

    await fs.rm(ownerPath, { force: true });
    await reloadOwnerStore();
    expect(getOwnerSnapshot()).toEqual({
      ownerContactId: null,
      ownerProfileSha256: null,
    });
    expect(matches(42, sha)).toBe(false);
    // Hash cleared so verifyRescueCode fails until next bind/load.
    expect(await verifyRescueCode("ANYCODE0")).toBe(false);
  });

  it("startOwnerStoreWatcher hot-reloads on external file rewrite", async () => {
    await loadOwnerStore(ownerPath);
    captureRescueCode();
    __test_setReloadDebounceMs(5);
    startOwnerStoreWatcher();

    // External writer replaces owner.json (atomic write-then-rename, same as
    // persist() does).
    const sha = "9".repeat(64);
    const tmp = `${ownerPath}.ext-tmp`;
    await fs.writeFile(
      tmp,
      JSON.stringify(
        {
          ownerContactId: 777,
          ownerProfileSha256: sha,
          createdAt: new Date().toISOString(),
          rescueCodeHash:
            "$2b$12$0123456789012345678901uG5VzZGmI8kT0IEvB.XR5J0M0cWfwYyu",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await fs.rename(tmp, ownerPath);

    // Wait debounce + a slack margin for the async readRecord to land.
    await sleep(80);

    expect(matches(777, sha)).toBe(true);
    stopOwnerStoreWatcher();
  });

  it("startOwnerStoreWatcher is idempotent", async () => {
    await loadOwnerStore(ownerPath);
    captureRescueCode();
    startOwnerStoreWatcher();
    // Calling twice must not throw and must not leak a second watcher.
    expect(() => startOwnerStoreWatcher()).not.toThrow();
    stopOwnerStoreWatcher();
  });

  it("startOwnerStoreWatcher throws if loadOwnerStore was not called first", () => {
    // __test_reset() in beforeEach already nulled ownerFilePath; we just
    // skip loadOwnerStore here to assert the guard.
    expect(() => startOwnerStoreWatcher()).toThrow(/loadOwnerStore/);
  });

  it("db_wipe_then_repair_requires_rescue_code", async () => {
    // First boot: owner.json minted, owner bound via rescue code, store persisted.
    await loadOwnerStore(ownerPath);
    const firstCode = captureRescueCode();
    const sha = "e".repeat(64);
    await bindOwner(123, sha);
    expect(matches(123, sha)).toBe(true);

    // Operator wipes the SimpleX DB AND owner.json (e.g., `rm -rf` of state).
    await fs.rm(ownerPath, { force: true });
    __test_reset();
    stderrWrites.length = 0;

    // Repair: re-launch. A fresh rescue code MUST be minted (different from
    // the first), and the old contact must NOT be auto-restored as owner.
    await loadOwnerStore(ownerPath);
    const secondCode = captureRescueCode();
    expect(secondCode).not.toBe(firstCode);
    expect(matches(123, sha)).toBe(false);

    // Old code must not verify against the freshly-minted hash.
    expect(await verifyRescueCode(firstCode)).toBe(false);
    expect(await verifyRescueCode(secondCode)).toBe(true);
  });
});
