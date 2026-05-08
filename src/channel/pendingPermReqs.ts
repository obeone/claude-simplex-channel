/**
 * Pending permission-request store — v2 plan §8 step 7.
 *
 * SINGLE-THREADED CONTRACT: this map is mutated and read only from the Node
 * event loop. The inbound router (`src/channel/router.ts`, PR 8a) reads it
 * synchronously between regex match and verdict decision. Any future change
 * MUST NOT introduce an `await` between regex-match and `pendingPermReqs.get`
 * — doing so reopens the TOCTOU window the plan §8 step 7 closes by design.
 *
 * Why a module-singleton instead of an injected store: the lookup happens on
 * every inbound DM and is the hottest path in the channel core. A
 * dependency-injected variant would force every inbound subscriber to keep
 * a reference; a module-singleton keeps the gate trivially testable
 * (`__test_reset()` clears state) without that ceremony.
 */
import { log } from "../util/log.js";

/** TTL for an outstanding pending permission request: 5 minutes per plan. */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/** Sweep interval for the expiry GC. */
export const SWEEP_INTERVAL_MS = 30 * 1000;

/**
 * Bookkeeping for an outstanding `permission_request`.
 *
 * `requestId` preserves the original case of the id Claude sent (used for
 * the verdict echo); the map key is the lowercased canonical form so the
 * router can compare without normalising at the call site.
 */
export interface PendingPermReqEntry {
  /** Original-case request id from Claude. Echoed in the verdict notification. */
  requestId: string;
  /** Tool name carried in the request (`Bash`, `Write`, `Edit`, …). */
  toolName: string;
  /** Free-form description shown to the owner in the DM. */
  description: string;
  /** Unix epoch ms after which the entry is dead and gets swept. */
  expiresAt: number;
}

/** Internal map. NEVER export — callers go through the API below. */
const entries = new Map<string, PendingPermReqEntry>();

/** Active sweep timer handle (null when sweep is not running). */
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Register a new pending permission request.
 *
 * Key is lowercased. If the same id is registered twice (e.g., a retry from
 * Claude), the new entry replaces the old — `expiresAt` is refreshed.
 */
export function set(
  requestId: string,
  toolName: string,
  description: string,
  now: number = Date.now(),
): void {
  // SINGLE-THREADED CONTRACT: pendingPermReqs is mutated and read only from
  // the Node event loop. handleInbound() is synchronous through the verdict
  // decision; awaits happen ONLY after the verdict is finalized. Any future
  // change must NOT add an await between regex-match and pendingPermReqs.get.
  entries.set(requestId.toLowerCase(), {
    requestId,
    toolName,
    description,
    expiresAt: now + PENDING_TTL_MS,
  });
}

/**
 * Look up a pending permission request by lowercased id.
 *
 * Returns undefined for unknown ids AND for ids whose entry has already
 * expired (lazy expiry — the sweep eventually drops them but a get between
 * sweeps must still return the right answer).
 *
 * No `await`. Synchronous. The router calls this between regex match and
 * verdict decision; introducing an await here would reopen the TOCTOU
 * window the SINGLE-THREADED CONTRACT closes.
 */
export function get(
  id: string,
  now: number = Date.now(),
): PendingPermReqEntry | undefined {
  // SINGLE-THREADED CONTRACT: pendingPermReqs is mutated and read only from
  // the Node event loop. handleInbound() is synchronous through the verdict
  // decision; awaits happen ONLY after the verdict is finalized. Any future
  // change must NOT add an await between regex-match and pendingPermReqs.get.
  // The lowercase here mirrors `set()` and is a defence-in-depth: the router
  // (PR 8a) already passes a lowercased id, but exposing a case-insensitive
  // public API is cheaper than a future bug from a non-router caller.
  const entry = entries.get(id.toLowerCase());
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    // Lazy expiry: the sweep will GC this on its next tick, but the lookup
    // itself must already treat it as gone.
    return undefined;
  }
  return entry;
}

/**
 * Drop the entry for an id (e.g. after a verdict has been emitted).
 *
 * Idempotent — deleting an unknown id is a no-op.
 */
export function del(id: string): void {
  entries.delete(id.toLowerCase());
}

/** Diagnostic: number of live (possibly-expired) entries. */
export function size(): number {
  return entries.size;
}

/**
 * Drop every expired entry. Returns the count removed.
 *
 * The TTL race noted in plan §8 step 7 (entry expires between sweep and
 * lookup) is acceptable: a regex match without a pending entry is forwarded
 * as a chat message by the router (PR 8a) — it never silently drops, so the
 * worst case is the owner sees their own `yes <id>` echoed back to Claude as
 * chat content rather than as a verdict. That is the intended fail-open
 * behaviour for stale ids.
 */
export function sweepExpired(now: number = Date.now()): number {
  let removed = 0;
  for (const [id, entry] of entries) {
    if (entry.expiresAt <= now) {
      entries.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    log.info({ evt: "pending_perm_req_sweep", removed });
  }
  return removed;
}

/**
 * Start the periodic TTL sweep. Idempotent — calling twice is a no-op.
 *
 * Call once at startup, after the MCP server is connected. The timer is
 * `unref()`'d so it does not keep the process alive on its own.
 */
export function startSweep(intervalMs: number = SWEEP_INTERVAL_MS): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    sweepExpired();
  }, intervalMs);
  sweepTimer.unref();
}

/**
 * Stop the periodic sweep. Tests call this in afterEach; production code
 * never calls it (the process exit clears the unref'd timer).
 */
export function stopSweep(): void {
  if (sweepTimer === null) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

/**
 * Reset module-level state. Tests only.
 */
export function __test_reset(): void {
  entries.clear();
  stopSweep();
}
