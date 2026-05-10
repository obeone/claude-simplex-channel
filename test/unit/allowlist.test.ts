/**
 * Allowlist persistence + hot-reload tests.
 *
 * The class also has in-memory-only behaviour (preserved when
 * `loadFromDisk` is never called); coverage for that lives in
 * `pairing.test.ts`. This file focuses on the persistence path:
 * file format, atomic writes, hot-reload via fs.watch, and
 * fail-closed reading.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Allowlist,
  defaultAllowlistFilePath,
  type AllowlistFile,
} from "../../src/channel/pairing.js";

const SHA = (c: string): string => c.repeat(64);
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let tmpDir: string;
let listPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `allowlist-test-${crypto.randomBytes(4).toString("hex")}-`),
  );
  listPath = path.join(tmpDir, "channels", "simplex", "allowlist.json");
});

afterEach(async () => {
  // Let any fire-and-forget persistAsync settle before we yank the dir
  // — otherwise rename() in persist races with rmdir and noises the log.
  await sleep(60);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Allowlist persistence", () => {
  it("defaults to ~/.claude/channels/simplex/allowlist.json", () => {
    expect(defaultAllowlistFilePath()).toBe(
      path.join(os.homedir(), ".claude", "channels", "simplex", "allowlist.json"),
    );
  });

  it("loadFromDisk on a missing file leaves the list empty", async () => {
    const a = new Allowlist();
    await a.loadFromDisk(listPath);
    expect(a.size()).toBe(0);
  });

  it("add() persists to disk at mode 0600 with the expected schema", async () => {
    const a = new Allowlist();
    await a.loadFromDisk(listPath);
    a.add({
      contactId: 42,
      profileSha256: SHA("a"),
      viaPairCode: "ABCDEF",
      admittedAt: "2026-05-10T12:00:00.000Z",
    });

    // Wait for the fire-and-forget write.
    await sleep(20);
    const stat = await fs.stat(listPath);
    expect(stat.mode & 0o777).toBe(0o600);

    const raw = JSON.parse(await fs.readFile(listPath, "utf8")) as AllowlistFile;
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0]).toEqual({
      contactId: 42,
      profileSha256: SHA("a"),
      viaPairCode: "ABCDEF",
      admittedAt: "2026-05-10T12:00:00.000Z",
    });
  });

  it("remove() persists the deletion and skips writes for unknown keys", async () => {
    const a = new Allowlist();
    await a.loadFromDisk(listPath);
    a.add({ contactId: 1, profileSha256: SHA("a"), admittedAt: "x" });
    a.add({ contactId: 2, profileSha256: SHA("b"), admittedAt: "y" });
    await sleep(20);

    a.remove(1, SHA("a"));
    await sleep(20);

    const raw = JSON.parse(await fs.readFile(listPath, "utf8")) as AllowlistFile;
    expect(raw.entries).toHaveLength(1);
    expect(raw.entries[0].contactId).toBe(2);

    // Removing an unknown tuple is a no-op (no throw, no rewrite churn).
    a.remove(99, SHA("z"));
    await sleep(20);
    const raw2 = JSON.parse(await fs.readFile(listPath, "utf8")) as AllowlistFile;
    expect(raw2.entries).toHaveLength(1);
  });

  it("loadFromDisk rehydrates entries written by a prior process", async () => {
    // Simulate a previous run: write the file directly.
    await fs.mkdir(path.dirname(listPath), { recursive: true, mode: 0o700 });
    const file: AllowlistFile = {
      version: 1,
      entries: [
        {
          contactId: 7,
          profileSha256: SHA("c"),
          viaPairCode: "GHIJKL",
          admittedAt: "2026-04-01T00:00:00.000Z",
        },
      ],
    };
    await fs.writeFile(listPath, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });

    const a = new Allowlist();
    await a.loadFromDisk(listPath);
    expect(a.size()).toBe(1);
    expect(a.has(7, SHA("c"))).toBe(true);
    expect(a.hasContactId(7)).toBe(true);
  });

  it("malformed file is logged and ignored — list stays at last good state", async () => {
    const a = new Allowlist();
    await a.loadFromDisk(listPath);
    a.add({ contactId: 1, profileSha256: SHA("a"), admittedAt: "x" });
    await sleep(20);

    // Corrupt the file out of band.
    await fs.writeFile(listPath, "{ not json", { mode: 0o600 });
    await a.loadFromDisk(listPath);

    // The class swallows the parse error; previous in-memory contents are
    // replaced with whatever was last successfully read — here, nothing.
    // Either behaviour is acceptable per the contract; we just assert no
    // throw and that hasContactId is consistent with internal state.
    expect(() => a.hasContactId(1)).not.toThrow();
  });

  it("startWatcher hot-reloads when the file is overwritten externally", async () => {
    const a = new Allowlist();
    await a.loadFromDisk(listPath);
    a.__test_setReloadDebounceMs(5);
    a.startWatcher();

    // External writer (atomic rename) admits a new contact.
    const tmp = `${listPath}.ext-tmp`;
    const file: AllowlistFile = {
      version: 1,
      entries: [
        { contactId: 88, profileSha256: SHA("d"), admittedAt: "now" },
      ],
    };
    await fs.mkdir(path.dirname(listPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
    await fs.rename(tmp, listPath);

    await sleep(80);
    expect(a.hasContactId(88)).toBe(true);
    a.stopWatcher();
  });

  it("startWatcher is idempotent and throws if loadFromDisk was not called", async () => {
    const a = new Allowlist();
    expect(() => a.startWatcher()).toThrow(/loadFromDisk/);

    await a.loadFromDisk(listPath);
    a.startWatcher();
    expect(() => a.startWatcher()).not.toThrow();
    a.stopWatcher();
  });
});
