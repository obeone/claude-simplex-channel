/**
 * Inbound channel router — v2 plan §8 step 8a (and 8b stub).
 *
 * The 2-step verdict gate per principle 4 / S1:
 *   1. Coarse owner gate: drop messages from senders not in the allowlist.
 *      Genesis path delegates to `src/owner/bind.ts`, which handles its own
 *      pre-allowlist `bind owner <CODE>` parsing.
 *   2. Regex shape match (verbatim per plan):
 *      `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`. NO match → forward as a
 *      chat notification. NEVER silently drop.
 *   3. Pending lookup: `pendingPermReqs.get(id)`. Miss → forward as chat
 *      (again, NEVER drop). The `[a-km-z]` class excludes `a/l/o` /
 *      `i/u`-collidable letters, keeping the false-positive rate against
 *      natural English low; the forward-as-chat path closes the remaining
 *      gap when the owner types something like "yes admin".
 *   4. Verdict emission: `emitVerdict` (worker-owner's PR 8b). PR 8a
 *      exposes a typed signature + a `setEmitVerdict` setter so the
 *      entrypoint can wire the real implementation once it lands.
 *
 * SINGLE-THREADED CONTRACT (mirrored in `pendingPermReqs.ts`):
 *   `handleInbound` is synchronous through the verdict decision. Awaits
 *   happen ONLY after `emitVerdict` is called. Any future change MUST NOT
 *   add an await between the regex match and `pendingPermReqs.get`.
 *
 * Forward path: when the message is not a verdict, the router calls
 * `forwardChat(msg)` which the entrypoint binds to an MCP
 * `notifications/claude/channel` emit. That keeps the router free of MCP
 * imports (testable without an in-memory transport pair).
 */
import * as pendingPermReqs from "./pendingPermReqs.js";

/** Verbatim per plan §8 step 8a. Do NOT relax the case class. */
export const RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

/** Sender tuple. The strict (contactId, sha) check is in PR 8b. */
export interface InboundSender {
  contactId: number;
  profileSha256: string;
}

/** Inbound message shape — what the router consumes. */
export interface InboundMsg {
  from: InboundSender;
  text: string;
}

/**
 * Action union returned by the router.
 *
 *   - `drop`:    sender failed `ownerGate`. The caller MUST NOT re-emit.
 *   - `chat`:    forward as a `notifications/claude/channel` chat to Claude.
 *   - `verdict`: a verdict has been emitted via `emitVerdict` (the result of
 *                that call is propagated unchanged, so verdict promises bubble
 *                up to the inbound subscriber's awaited dispatch path).
 */
export type Action =
  | { kind: "drop" }
  | { kind: "chat"; msg: InboundMsg }
  | { kind: "verdict"; allow: boolean; id: string };

/** Coarse owner gate. Sync — the strict tuple match lives in PR 8b. */
export type OwnerGate = (sender: InboundSender) => boolean;

/**
 * `emitVerdict` signature.
 *
 * Worker-owner implements this in PR 8b. It must:
 *   1. Strict tuple-match: `ownerStore.matches(msg.from.contactId, sha)`.
 *      Failure → forward as chat (NEVER emit verdict).
 *   2. `mcp.notification({ method: "notifications/claude/channel/permission",
 *      params: { request_id: id, behavior: allow ? "allow" : "deny" } })`.
 *   3. `pendingPermReqs.del(id)`.
 *
 * Returning the resolved promise lets the inbound subscriber chain it.
 */
export type EmitVerdict = (
  id: string,
  allow: boolean,
  msg: InboundMsg,
) => Promise<Action>;

/** PR 8a-side stub. PR 8b wires the real one via `setEmitVerdict`. */
let emitVerdictImpl: EmitVerdict = async () => {
  throw new Error(
    "emitVerdict not wired — call setEmitVerdict() from the entrypoint " +
      "after PR 8b lands (worker-owner)",
  );
};

/**
 * Hot-swap the verdict emitter. Called once from the entrypoint after the
 * MCP server is connected. Tests inject their own emitter directly.
 */
export function setEmitVerdict(impl: EmitVerdict): void {
  emitVerdictImpl = impl;
}

/**
 * Forward-chat callback. The router does not import the MCP server module;
 * the entrypoint binds this to a closure over the connected `Server`.
 */
export type ForwardChat = (msg: InboundMsg) => Action;

/**
 * Build a `handleInbound` closed over its dependencies.
 *
 * SINGLE-THREADED CONTRACT — DO NOT INTRODUCE AWAITS BETWEEN the regex
 * match and `pendingPermReqs.get(id)`. The verdict-or-chat decision must
 * complete on the same event-loop turn the message arrived on. The only
 * awaitable side effect is `emitVerdict` itself, after the decision is
 * finalized.
 */
export function makeHandleInbound(deps: {
  ownerGate: OwnerGate;
  forwardChat: ForwardChat;
}): (msg: InboundMsg) => Action | Promise<Action> {
  return (msg: InboundMsg): Action | Promise<Action> => {
    if (!deps.ownerGate(msg.from)) return { kind: "drop" };
    const match = msg.text.match(RE);
    if (!match) return deps.forwardChat(msg);
    const id = match[2].toLowerCase();
    const pending = pendingPermReqs.get(id);
    if (!pending) return deps.forwardChat(msg);
    // Single-use intent: the verdict emitter (PR 8b) is responsible for
    // calling `pendingPermReqs.del(id)` after a successful emission so a
    // duplicate `yes <id>` from the owner would forward-as-chat instead of
    // re-emitting (the second call lands here with `pending===undefined`).
    return emitVerdictImpl(id, match[1].toLowerCase().startsWith("y"), msg);
  };
}

/**
 * Reset module-level state. Tests only.
 */
export function __test_reset(): void {
  emitVerdictImpl = async () => {
    throw new Error("emitVerdict not wired");
  };
}
