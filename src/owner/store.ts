/**
 * Owner identity store.
 *
 * Per docs/plans/v2-claude-simplex-channel.md §8 step 4 (and steps 7, 8b, 9).
 *
 * Owner identity is a tuple `(contactId, profileSha256)` bound to a one-time
 * **rescue code** stored bcrypt-hashed at rest. First-connect does NOT grant
 * ownership — the rescue code (printed once on stderr at first launch) is
 * the only path to genesis binding via `bind owner <CODE>` (handled by
 * `src/owner/bind.ts` consumer).
 *
 * ## Synchronous owner cache (load-bearing)
 *
 * The `matches(contactId, profileSha256)` predicate MUST be synchronous in
 * memory — no `await`. The router (`src/channel/router.ts`) calls it inside
 * `handleInbound` between regex match and verdict emission, on the same
 * event-loop turn. A synchronous cache is the only way to avoid TOCTOU
 * between the regex hit and the owner-tuple check (per plan §8 step 7).
 *
 * Cache lifecycle:
 *   - Loaded ONCE at startup via `loadOwnerStore()`, before MCP/SimpleX
 *     wiring. The async I/O happens here, not in the hot path.
 *   - Invalidated synchronously on `ContactUpdated` for the owner contact
 *     when the profile sha256 changes (PR 9, `clearOwnerSync`). A new
 *     rescue code is minted and persisted in the background; the in-memory
 *     cache flip itself is sync.
 *   - Updated synchronously on successful `bind owner <CODE>` via
 *     `setOwnerSync` (consumed by `src/owner/bind.ts` in worker-state's PR).
 *
 * ## Secret discipline
 *
 *   - Plain rescue code: printed exactly once to stderr (`writeRescueCodeOnce`),
 *     never logged at INFO+ (the structured `log` interface refuses it by
 *     contract — there is no entry point that accepts it). Never echoed in
 *     MCP frames. Never persisted in plain text.
 *   - Hash: bcrypt cost 12. Stored in `owner.json` mode 0600.
 *
 * ## File shape
 *
 * `~/.claude/channels/simplex/owner.json`:
 *
 *   {
 *     "ownerContactId":     number | null,
 *     "ownerProfileSha256": string | null,   // hex, 64 chars
 *     "createdAt":          string,          // ISO-8601 UTC
 *     "rescueCodeHash":     string           // bcrypt $2b$12$...
 *   }
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import bcrypt from "bcrypt";

import { log } from "../util/log.js";

/** Crockford base32 alphabet — excludes I, L, O, U for ambiguity. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** bcrypt work factor for the rescue-code hash. Per plan §8 step 4. */
const BCRYPT_COST = 12;

/** Rescue code length in characters. 5 bytes = 40 bits = exactly 8 base32 chars. */
const RESCUE_CODE_BYTES = 5;
const RESCUE_CODE_CHARS = 8;

/**
 * On-disk shape of `owner.json`. Field names are part of the persistence
 * contract — renaming any of these breaks rolling upgrades.
 */
export interface OwnerRecord {
  ownerContactId: number | null;
  ownerProfileSha256: string | null;
  createdAt: string;
  rescueCodeHash: string;
}

/**
 * Synchronous in-memory owner identity. See module JSDoc — must be
 * readable without `await` from the inbound router hot path.
 */
interface OwnerCache {
  ownerContactId: number | null;
  ownerProfileSha256: string | null;
}

let cache: OwnerCache = {
  ownerContactId: null,
  ownerProfileSha256: null,
};

let ownerFilePath: string | null = null;
let rescueCodeHash: string | null = null;
let createdAt: string | null = null;

/**
 * Hot-reload state.
 *
 * `watcher` is the live `fs.FSWatcher` on the owner.json's parent directory
 * (we watch the dir, not the file, because atomic write-then-rename in
 * `persist()` orphans file-level inotify/kqueue handles after the rename).
 *
 * `reloadTimer` debounces rapid event bursts — atomic rename on macOS/Linux
 * fires a "rename" + "change" pair within ~ms; we coalesce them into a
 * single re-read so the cache flips at most once per logical mutation.
 *
 * `reloadDebounceMs` is exposed so tests can lower it to keep timeouts tight
 * (50ms is plenty in production; 5ms is enough for tests racing fs ops).
 */
let watcher: fsSync.FSWatcher | null = null;
let reloadTimer: NodeJS.Timeout | null = null;
let reloadDebounceMs = 50;

/**
 * Default location of `owner.json` per plan §7.
 *
 * `~/.claude/channels/simplex/owner.json` — kept under the user's Claude
 * config dir, not under XDG_STATE_HOME, because it is identity (config),
 * not cache (state). This is intentional: a `rm -rf ~/.local/state/...`
 * to wipe SQLite must NOT remove the owner identity.
 */
export function defaultOwnerFilePath(): string {
  return path.join(os.homedir(), ".claude", "channels", "simplex", "owner.json");
}

/**
 * Encode a Buffer as Crockford base32 (uppercase, no padding).
 *
 * 5 input bytes → 8 output chars exactly (40 bits, no padding remainder).
 * For other lengths the last partial group emits `ceil(bits / 5)` chars.
 * We only ever feed it 5 bytes for rescue codes, so the 8-char result is
 * deterministic and tested.
 */
function crockfordBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Mint a fresh rescue code and its bcrypt hash.
 *
 * Returns both because the only legitimate caller is the
 * persistence path that must (a) print the plain code once on stderr and
 * (b) write the hash to disk. The plain code is never returned anywhere
 * else and never logged.
 */
async function mintRescueCode(): Promise<{ plain: string; hash: string }> {
  const plain = crockfordBase32(crypto.randomBytes(RESCUE_CODE_BYTES));
  if (plain.length !== RESCUE_CODE_CHARS) {
    // Defensive: 5 bytes always yields 8 chars. If this ever fires the
    // alphabet or the encoder has been tampered with.
    throw new Error(
      `rescue code mint produced ${plain.length} chars, expected ${RESCUE_CODE_CHARS}`,
    );
  }
  const hash = await bcrypt.hash(plain, BCRYPT_COST);
  return { plain, hash };
}

/**
 * Print the rescue code on stderr exactly once, in the canonical format.
 *
 * The leading `RESCUE CODE` token is the operator-facing contract — do not
 * change wording without updating the README and the operator-facing
 * acceptance test in §9.
 */
function writeRescueCodeOnce(plain: string, kind: "first-launch" | "rotation"): void {
  const banner =
    kind === "first-launch"
      ? `RESCUE CODE (first-launch, save it now): ${plain}\n`
      : `OWNER PROFILE CHANGED — demoted to allowlist. New rescue code: ${plain}. Re-bind via "bind owner <CODE>".\n`;
  process.stderr.write(banner);
}

/**
 * Atomically persist the owner record at mode 0600.
 *
 * Write-then-rename via `O_CREAT|O_EXCL` semantics on the temp path so a
 * concurrent crash never leaves a half-written `owner.json`. The temp file
 * is created with mode 0600 directly (not chmod after-the-fact) so the
 * window where the file exists at a wider mode is zero.
 */
async function persist(filePath: string, record: OwnerRecord): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

/**
 * Read `owner.json` if it exists. Returns null on ENOENT, throws otherwise.
 *
 * We do NOT silently recover from malformed JSON — that would mask
 * tampering or a partial write that the rename-atomic write should have
 * prevented. Operator must intervene.
 */
async function readRecord(filePath: string): Promise<OwnerRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as OwnerRecord;
  if (
    typeof parsed.rescueCodeHash !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error(`owner.json malformed: missing required fields at ${filePath}`);
  }
  return parsed;
}

/**
 * Load (or initialize) the owner store.
 *
 * Call ONCE at startup, before wiring the SimpleX adapter and the MCP
 * router. After this resolves, `matches()` is safe to call synchronously
 * from the hot path.
 *
 * If `owner.json` does not exist, mint a new rescue code, print it on
 * stderr, persist the bcrypt hash. This is the genesis path — see plan
 * §8 step 4. The plain code is printed exactly once and never returned.
 *
 * @param filePath - Override for tests; production callers omit this.
 */
export async function loadOwnerStore(filePath?: string): Promise<void> {
  ownerFilePath = filePath ?? defaultOwnerFilePath();
  const existing = await readRecord(ownerFilePath);

  if (existing) {
    cache = {
      ownerContactId: existing.ownerContactId,
      ownerProfileSha256: existing.ownerProfileSha256,
    };
    rescueCodeHash = existing.rescueCodeHash;
    createdAt = existing.createdAt;
    log.info({
      evt: "owner_store_loaded",
      bound: existing.ownerContactId !== null,
    });
    return;
  }

  // Genesis: no owner.json yet. Mint and persist.
  const { plain, hash } = await mintRescueCode();
  createdAt = new Date().toISOString();
  rescueCodeHash = hash;
  cache = { ownerContactId: null, ownerProfileSha256: null };
  const record: OwnerRecord = {
    ownerContactId: null,
    ownerProfileSha256: null,
    createdAt,
    rescueCodeHash: hash,
  };
  await persist(ownerFilePath, record);
  writeRescueCodeOnce(plain, "first-launch");
  log.info({ evt: "owner_store_initialized" });
}

/**
 * Synchronous owner-tuple check. The router's verdict gate (PR 8b).
 *
 * Returns true iff there IS a bound owner AND the supplied tuple matches
 * the cached owner identity exactly. An unbound store (genesis state)
 * always returns false.
 *
 * No I/O, no `await`, no exceptions. Safe to call from the inbound router
 * on every message.
 */
export function matches(
  contactId: number,
  profileSha256: string,
): boolean {
  if (cache.ownerContactId === null || cache.ownerProfileSha256 === null) {
    return false;
  }
  return (
    cache.ownerContactId === contactId &&
    cache.ownerProfileSha256 === profileSha256
  );
}

/**
 * Snapshot of the current owner cache (for diagnostics / tests).
 *
 * Returns a defensive copy — caller cannot mutate the live cache through
 * this reference.
 */
export function getOwnerSnapshot(): OwnerCache {
  return {
    ownerContactId: cache.ownerContactId,
    ownerProfileSha256: cache.ownerProfileSha256,
  };
}

/**
 * Verify a candidate plain rescue code against the stored bcrypt hash.
 *
 * Consumed by `src/owner/bind.ts` (PR 5, worker-state) when parsing
 * `bind owner <CODE>` from an inbound DM. Returns false if no hash is
 * loaded yet (caller must `loadOwnerStore` first).
 *
 * Plain code is NEVER logged from this function — bcrypt's compare is
 * timing-safe enough for an 8-char code over the SimpleX channel; we do
 * not add a second comparison.
 */
export async function verifyRescueCode(plain: string): Promise<boolean> {
  if (rescueCodeHash === null) return false;
  return bcrypt.compare(plain, rescueCodeHash);
}

/**
 * Promote a contact tuple to owner.
 *
 * Called by the bind handler (PR 5) after `verifyRescueCode` returns true.
 * Updates the synchronous cache FIRST (so the router sees the new owner
 * on the very next event-loop turn) and persists asynchronously.
 *
 * Per plan §8 step 4: a successful bind also rotates the rescue code so
 * the same code cannot be replayed. The rotation is best-effort — if
 * persistence fails the cache change still stands (operator can re-mint
 * by deleting owner.json).
 */
export async function bindOwner(
  contactId: number,
  profileSha256: string,
): Promise<void> {
  if (ownerFilePath === null || createdAt === null) {
    throw new Error("owner store not loaded — call loadOwnerStore() first");
  }
  cache = { ownerContactId: contactId, ownerProfileSha256: profileSha256 };

  const { plain, hash } = await mintRescueCode();
  rescueCodeHash = hash;
  const record: OwnerRecord = {
    ownerContactId: contactId,
    ownerProfileSha256: profileSha256,
    createdAt,
    rescueCodeHash: hash,
  };
  await persist(ownerFilePath, record);
  // Rotated rescue code printed so the operator can save the next genesis
  // path in case the bound owner ever needs to re-bind.
  writeRescueCodeOnce(plain, "rotation");
  log.info({ evt: "owner_bound" });
}

/**
 * Synchronously demote owner to allowlist on profile change (PR 9).
 *
 * Cache is cleared immediately on the same turn the `ContactUpdated`
 * handler fires — that is the load-bearing invariant: the very next
 * inbound message routed through `matches()` MUST see a null owner.
 *
 * Persistence and rescue-code rotation happen in the background via
 * `rotateAfterDemotion()`; if that promise rejects, the cache stays
 * cleared (fail-closed).
 */
export function clearOwnerSync(): void {
  cache = { ownerContactId: null, ownerProfileSha256: null };
}

/**
 * Background rotation after `clearOwnerSync()` (PR 9).
 *
 * Mints a new rescue code, persists owner.json with both tuple fields
 * nulled, and prints the new code on stderr in the rotation banner.
 * Returns the promise so the caller can `void`-await or await for
 * deterministic test ordering.
 */
export async function rotateAfterDemotion(): Promise<void> {
  if (ownerFilePath === null || createdAt === null) {
    throw new Error("owner store not loaded — call loadOwnerStore() first");
  }
  const { plain, hash } = await mintRescueCode();
  rescueCodeHash = hash;
  const record: OwnerRecord = {
    ownerContactId: null,
    ownerProfileSha256: null,
    createdAt,
    rescueCodeHash: hash,
  };
  await persist(ownerFilePath, record);
  writeRescueCodeOnce(plain, "rotation");
  log.warn({ evt: "owner_demoted_profile_change" });
}

/**
 * Re-read `owner.json` and update the synchronous in-memory cache.
 *
 * Called by the file watcher when `owner.json` changes on disk — e.g. when
 * an external admin CLI rotates the rescue code or revokes an owner, or
 * when another simplex MCP process bound an owner via `bind owner` while
 * we held a stale cache. Idempotent: re-reading the same content leaves
 * cache state unchanged.
 *
 * If the file is missing (operator wiped it for genesis recovery), the
 * cache resets to unbound and `rescueCodeHash` is cleared so
 * `verifyRescueCode` fails until the next external mint or a fresh
 * `loadOwnerStore` call.
 *
 * Errors (malformed JSON, permission, etc.) are logged but never thrown —
 * the cache stays at its last good state. The watcher will retry on the
 * next change event.
 */
export async function reloadOwnerStore(): Promise<void> {
  if (ownerFilePath === null) return;
  try {
    const existing = await readRecord(ownerFilePath);
    if (existing) {
      cache = {
        ownerContactId: existing.ownerContactId,
        ownerProfileSha256: existing.ownerProfileSha256,
      };
      rescueCodeHash = existing.rescueCodeHash;
      createdAt = existing.createdAt;
      log.info({
        evt: "owner_store_reloaded",
        bound: existing.ownerContactId !== null,
      });
    } else {
      cache = { ownerContactId: null, ownerProfileSha256: null };
      rescueCodeHash = null;
      log.warn({ evt: "owner_store_file_missing" });
    }
  } catch (err) {
    log.error({ evt: "owner_store_reload_failed", error: String(err) });
  }
}

/**
 * Install an `fs.watch` on `owner.json`'s parent directory and re-read on
 * every change event matching the file basename. Idempotent — second call
 * is a no-op.
 *
 * We watch the parent directory, not the file itself, because the atomic
 * write-then-rename pattern in `persist()` orphans a file-level watcher:
 * after `rename()` the inode the watcher held is gone and no further
 * events arrive on it.
 *
 * Multiple events fired by a single atomic write are coalesced via the
 * `reloadDebounceMs` timer; the cache flips at most once per logical
 * mutation.
 */
export function startOwnerStoreWatcher(): void {
  if (watcher) return;
  if (ownerFilePath === null) {
    throw new Error("startOwnerStoreWatcher: loadOwnerStore() must run first");
  }
  const dir = path.dirname(ownerFilePath);
  const target = path.basename(ownerFilePath);
  watcher = fsSync.watch(dir, { persistent: false }, (_eventType, name) => {
    if (name !== target) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void reloadOwnerStore();
    }, reloadDebounceMs);
  });
  log.info({ evt: "owner_store_watcher_started", dir });
}

/** Tear down the watcher and any pending debounce timer. Idempotent. */
export function stopOwnerStoreWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
}

/**
 * Test seam: lower the debounce so race tests stay fast. Production never
 * calls this. Returns the previous value so tests can restore.
 */
export function __test_setReloadDebounceMs(ms: number): number {
  const prev = reloadDebounceMs;
  reloadDebounceMs = ms;
  return prev;
}

/**
 * Reset module-level state. Tests only — production code never calls this.
 *
 * Vitest reuses the module across test files in the same worker; without
 * a reset hook, tests would leak each other's owner cache.
 */
export function __test_reset(): void {
  stopOwnerStoreWatcher();
  cache = { ownerContactId: null, ownerProfileSha256: null };
  ownerFilePath = null;
  rescueCodeHash = null;
  createdAt = null;
  reloadDebounceMs = 50;
}
