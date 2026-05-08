# claude-simplex-channel — v2 Implementation Plan (Iteration 2 (patched))

> Iteration 2 (patched). Revises v1 to address Architect S1–S4 and the Critic's
> 7 required changes. Recommendation unchanged: Option A (single-process Node
> MCP server embedding `simplex-chat@6.5.x`). Hard constraints preserved:
> Node.js, simplex-chat 6.5.x native lib, 1:1 + permission relay, code-based
> pairing, claude.ai auth.

---

## 1. Title

**Project**: `claude-simplex-channel`
**Goal**: A Claude Code channel (MCP stdio server) that bridges Claude's local
session to a single SimpleX peer over `simplex-chat@6.5.x`. Bidirectional chat
plus permission relay (`Bash`/`Write`/`Edit`/...).
**Non-goals (v1)**: groups, files, multi-owner, Web/iOS, encryption-at-rest of
state beyond what SimpleX already provides.

---

## 2. Principles (revised after S3 + S4)

1. **Stdout purity is invariant.** Channel MCP frames are the *only* bytes that
   ever touch fd 1 of the server process. Anything else (Haskell logs, console
   noise, addon prints) goes to stderr or a side fd. Verified empirically by a
   gating CI smoke against the real `simplex-chat@6.5.x` addon (step 1.5).
2. **Sender gating before content gating.** Every inbound SimpleX event is
   filtered on `(contactId, profileSha256)` *before* regex/text inspection.
   `chat.id` is never used for trust decisions.
3. **Identity is a tuple, not a contact slot.**
   *Owner* = `(contactId, profileSha256)` bound to a one-time **rescue code**
   stored bcrypt-hashed at rest. First-connect does NOT grant ownership.
   (Replaces v1's "first contact = owner" rule, per S3.)
4. **Permission verdicts are owner-only and gated by a 2-step lookup.**
   Regex match alone never produces a verdict. Verdict requires
   (i) regex match, (ii) `pendingPermReqs` lookup hit on lowercased id,
   (iii) sender == current owner tuple. Anything else is forwarded as a
   normal channel notification (per S1).
5. **No model-callable pairing surface.** The MCP server exposes `reply` (and
   optionally `mark_read`). It does NOT expose `pair_contact` or any admin
   tool. Pairing is owner-driven via SimpleX-side DM-back of a short code, or,
   for genesis, via the rescue code printed once on stderr (per S4).

> *Principle softening (v1 → v2)*: Principle 3 in v1 ("first contact = owner")
> is **replaced**, not softened, by the rescue-code model. Rationale: the
> Critic showed first-contact is racy under SimpleX address auto-accept and
> profile-spoofable; rescue code closes both holes.

---

## 3. Decision Drivers (top 3)

1. **Operator simplicity over flexibility.** One process, one binary, one
   `.env`. No sidecar lifecycle for v1.
2. **Stdout-purity blast radius.** Embedding the SimpleX core in the MCP
   process is only viable if the addon never writes to fd 1. This is the
   single largest technical risk and gates the entire plan (step 1.5).
3. **Auditable trust boundary.** Owner identity must survive incognito
   reconnections, profile changes, and DB wipes without silent re-grant.

---

## 4. Options considered (>=2 viable)

| Option | Shape | Pros | Cons | Status |
|---|---|---|---|---|
| **A. Single-process Node MCP + `simplex-chat@6.5.x`** | One Node binary, MCP stdio + embedded SimpleX core | Simplest install; one supervisor; warm SQLite reuse on restart | Stdout-purity risk; addon crash = MCP crash | **Recommended** |
| **B. Two-process: MCP stdio + child `simplex-chat` CLI over WS** | MCP wraps a child process speaking the WebSocket API | Stdout-purity trivially solved (CLI's stdout is its own fd) | Two binaries to ship/version; pairing/state split | Viable alternative (kept warm) |
| **C. Sidecar daemon + thin MCP shim** | `simplex-chat-daemon` runs separately; MCP only translates | Process isolation; daemon survives Claude restarts | Operator must manage two services; defeats v1 simplicity | **Auto-escalation target if step 1.5 fails on any of 3 platforms** |

> Both B and C remain viable; neither is silently dropped. The plan
> auto-converts to C if step 1.5's empirical smoke fails on Linux x64,
> macOS x64, OR macOS arm64. Option B stays documented as the next pivot if
> C's operator burden proves unacceptable in pilot.

---

## 5. Pre-mortem (3 failure scenarios)

a. **Stdout violation in production.** SimpleX addon prints a Haskell warning
   to fd 1 mid-session → MCP frame stream corrupted → Claude Code disconnects
   the channel. Mitigated by step 1.5 (CI gate plus runtime fd-1 redirect to
   stderr; SDK writes via captured side fd 3).
b. **DB clobber across two project sessions.** Two `claude` processes in two
   project dirs share the same SimpleX SQLite prefix → one wipes the other's
   subscriptions. Mitigated by per-project DB prefix (step 2: `projectHash`
   under `XDG_STATE_HOME`/`Library/Application Support`).
c. **Owner spoof via incognito repair.** Attacker DMs the bot under the
   owner's display name after a connection drop, claiming to be owner.
   Mitigated by S3 identity tuple plus rescue code: identity =
   `(contactId, profileSha256)`, rotation on profile change, re-bind
   requires fresh rescue code (which only the operator's stderr ever saw).

---

## 6. Architecture

```
+---------------------------------------------------+
| Node process                                      |
|                                                   |
|  +--------------+        +-----------------------+|
|  | MCP stdio    | <----> | @modelcontextprotocol ||
|  | (fd 1 = MCP) |        | /sdk server           ||
|  +------+-------+        +-----------+-----------+|
|         ^                            |            |
|         |                            v            |
|  +------+--------+        +----------+---------+  |
|  | Channel core  | <----> | SimpleX adapter    |  |
|  | (TS modules)  |        | (simplex-chat@6.5) |  |
|  +---------------+        +----------+---------+  |
|         ^                            |            |
|         |                            v            |
|  +------+----+              +--------+---------+  |
|  | Owner store|             | SQLite (per-proj)|  |
|  | (bcrypt)   |             | prefix path      |  |
|  +------------+             +------------------+  |
|                                                   |
|  fd 1 -> MCP frames only (gated, see step 1.5)    |
|  fd 2 -> all logs (channel + addon stderr passthru)|
|  fd 3 -> SDK indirect write target (dup of orig 1) |
+---------------------------------------------------+
```

Key flows:

- **Inbound DM**: SimpleX `NewChatItems` → adapter → owner-gate (S3) →
  permission-regex 2-step gate (S1, step 8a/8b) → either emit
  `notifications/claude/channel/permission` (verdict) OR
  `notifications/claude/channel` (chat).
- **Outbound reply**: MCP `CallTool` `reply` → adapter `APISendMessages` to
  owner contactId.
- **Permission relay**: Claude Code → `notifications/claude/channel/permission_request`
  → store `{request_id → {expiresAt}}` in `pendingPermReqs` →
  `APISendMessages` to owner with `yes <id>` / `no <id>` instructions.
- **Pairing (S4)**:
  - *Genesis*: stderr-printed rescue code → first DM `bind owner <CODE>` from
    any allowlisted contact promotes that `(contactId, profileSha256)` to
    owner; new rescue code minted and stderr-printed.
  - *Stranger appears*: adapter mints 6-char alnum `pairCode`, 5 min TTL,
    one-shot, bound to connectionId. Code is DMed to stranger AND emitted as
    `notifications/claude/channel` with `meta.kind=pairing_prompt`
    (informational; Claude has no tool to act). Operator (already-owner) DMs
    the code back from THEIR contact to commit the new contact to allowlist.

---

## 7. File layout

```
claude-simplex-channel/
  package.json                 # name, bin, type=module, engines node>=20
                               # "bin": { "claude-simplex-channel": "./bin/claude-simplex-channel" }
  tsconfig.json
  bin/
    claude-simplex-channel     # POSIX sh wrapper: exec node dist/index.js 3>&1 1>&2
  src/
    index.ts                   # entrypoint: stdout redirect FIRST, then MCP/adapter
    mcp/
      server.ts                # McpServer construction, capabilities, instructions
      tools.ts                 # ListTools/CallTool: reply, mark_read
      permission.ts            # setNotificationHandler for permission_request
    channel/
      router.ts                # 2-step gate (S1)
      pendingPermReqs.ts       # in-memory map, TTL, single-threaded reasoning
      pairing.ts               # 6-char pairCode store, 5min TTL, single-use
    simplex/
      adapter.ts               # bot.run wiring, event subscriptions, send wrapper
      events.ts                # NewChatItems / ContactConnected / ContactUpdated / ReceivedContactRequest
      profile.ts               # sha256(profile) helper, ContactUpdated demotion
    owner/
      store.ts                 # owner.json read/write, bcrypt rescue-code mint/verify
      bind.ts                  # `bind owner <CODE>` parser + handler
    util/
      stdoutGate.ts            # fd dup dance; SDK Writable on fd 3
      paths.ts                 # XDG_STATE_HOME / Application Support, projectHash
      log.ts                   # stderr-only logger; never INFO+ for secrets
  test/
    unit/
      stdout_gate.test.ts
      pending_perm_reqs.test.ts
      paths.test.ts            # db_prefix_isolated_per_project_dir
      router.test.ts           # permission_regex_without_pending_forwards_as_chat,
                               # permission_id_mismatch_forwards_as_chat
      owner_store.test.ts      # incognito_repair_does_not_grant_owner,
                               # db_wipe_then_repair_requires_rescue_code,
                               # profile_change_demotes_to_allowlist_pending_rescue
    integration/
      stdout_purity_60s_smoke.ts   # CI gate, runs in child Node, monkey-patches process.stdout.write
      addon_crash_restart_reopens_verdict_window.ts
  scripts/
    smoke-stdout.mjs           # invoked by CI on linux-x64, macos-x64, macos-arm64
  .env.example                 # SIMPLEX_DB_PASSPHRASE etc.
  README.md
```

State paths:

```
~/.local/state/claude-simplex-channel/<projectHash>/db.*    # Linux
~/Library/Application Support/claude-simplex-channel/<projectHash>/db.*  # macOS
~/.claude/channels/simplex/owner.json                        # bcrypt + tuple
```

---

## 8. Build sequence — BEFORE / AFTER

### BEFORE (v1, 8 steps)

```
1.  MCP skeleton (stdio, capabilities, instructions)
2.  Per-project DB prefix
3.  SimpleX adapter bring-up (bot.run, NewChatItems)
4.  Allowlist (first-contact = owner)
5.  Pairing tool (`pair_contact`) exposed via MCP tools
6.  Reply tool
7.  Permission relay handler (request side)
8.  Permission verdict regex -> emit verdict (single-step, silent on miss)
```

### AFTER (v2, 11 steps with 1.5 / 8a / 8b inserted, step 5 rewritten)

```
1.   MCP skeleton (stdio, capabilities, instructions)
1.5  Stdout-purity gate (CI smoke + runtime fd-1 redirect; gates plan)
2.   Per-project DB prefix (XDG_STATE_HOME / Application Support, projectHash)
3.   SimpleX adapter bring-up (bot.run, NewChatItems, ReceivedContactRequest)
4.   Owner store (bcrypt rescue code, owner.json) + stderr first-launch print
5.   Pairing model (NO MCP tool): pairCode mint + DM-back from owner protocol
6.   Reply tool (only model-callable surface besides optional mark_read)
7.   Permission relay request handler (DM owner with yes/no <id> instructions)
8a.  Inbound regex match -> lookup pendingPermReqs[id.toLowerCase()]; on miss -> forward as chat
8b.  Owner-gated verdict emission (regex hit + pending hit + sender==owner tuple)
9.   ContactUpdated: profileSha256 change on owner -> demote to allowlist, require re-bind
10.  Addon-crash policy + warm-restart smoke
```

### Step-by-step detail

#### Step 1 — MCP skeleton

- `McpServer` constructed with `name: "simplex"`, `version: "0.1.0"`.
- Capabilities (final, post-S4):

  ```ts
  capabilities: {
    experimental: {
      'claude/channel': {},
      'claude/channel/permission': {},
    },
    tools: {},   // declares the namespace; ListTools returns ONLY `reply`
                 // (and optional `mark_read`) — NO `pair_contact`
  }
  ```

- `instructions` string (final wording — addresses S1 step 8a):

  > "Messages arrive as `<channel source=\"simplex\" chat_id=\"...\">`. Reply
  > with the `reply` tool, passing `chat_id` from the tag. The owner may
  > always reply naturally to the bot — only literal `yes <id>` or `no <id>`
  > matching an active permission prompt are intercepted as verdicts;
  > anything else (including `yes`, `approve it`, or an unknown id) is
  > forwarded to you as a normal channel message. Never quote
  > `meta.pair_code` back over the `reply` tool — it must reach the operator
  > only via stderr / channel notification, not via SimpleX echo to a wrong
  > contact."

- Transport: `StdioServerTransport`. `mcp.connect(transport)` is called AFTER
  step 1.5's fd dance.

#### Step 1.5 — Stdout-purity gate (NEW, S2)

**CI harness** (`scripts/smoke-stdout.mjs`, runs on linux-x64, macos-x64,
macos-arm64):

- Spawns a child Node process with `--enable-source-maps`.
- Child sets `process.stdout.write = () => { throw new Error("STDOUT_VIOLATION"); };`
  *before* `import('simplex-chat')`.
- Child constructs the SimpleX bot in `minimal` mode and calls `bot.run({...})`.
- Runs for 60 s under a watchdog. Asserts: no `STDOUT_VIOLATION` thrown,
  zero bytes observed on the child's fd 1 by the parent (`pipe` capture).
- CI artifact: `stdout-purity-${os}-${arch}.json` with byte count + duration.
  One-line stderr summary: `STDOUT_PURITY: PASS|FAIL os=... arch=... bytes=N`.

**Runtime fd-1 redirect — wrapper-process model (fd-level, not JS-level):**

Stdout fencing is enforced by the kernel via a thin shell wrapper. The Node
binary is never invoked directly by Claude Code — it is invoked through
`bin/claude-simplex-channel`, which performs the fd dance before exec:

```sh
#!/usr/bin/env sh
# bin/claude-simplex-channel
# Preserve original fd 1 as fd 3 (the SDK's writer target),
# then collapse fd 1 onto fd 2 (so any non-MCP write to fd 1 lands on stderr).
exec node "$(dirname "$0")/../dist/index.js" 3>&1 1>&2
```

Inside `src/index.ts`, the SDK transport is constructed against fd 3:

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/index.js';

const sdkStdout = fs.createWriteStream(null as unknown as string, { fd: 3 });
const transport  = new StdioServerTransport(process.stdin, sdkStdout);
const mcp        = new McpServer(/* ... */);
await mcp.connect(transport);
```

`src/util/stdoutGate.ts` becomes a thin guard that asserts at startup:

```ts
// src/util/stdoutGate.ts
import * as fs from 'node:fs';
export function assertStdoutGate(): void {
  // Fd 3 must be open and writable (set up by bin/claude-simplex-channel).
  try { fs.fstatSync(3); }
  catch {
    process.stderr.write('FATAL: fd 3 not open — launch via bin/claude-simplex-channel, not `node` directly.\n');
    process.exit(2);
  }
}
```

**Rationale (Architect):** native libc writes from the simplex-chat addon
(Haskell RTS, OpenSSL, SQLite) bypass `process.stdout` and would corrupt MCP
frames if we relied on a JS-land Writable swap. The kernel-level redirect is
the only mechanism that catches both JS and native writes uniformly.

**Cross-platform path detail:** `/dev/fd/1` is present on macOS and on Linux
glibc/musl (musl provides it via `/proc/self/fd/N`). The wrapper above does
not need `/dev/fd/N` at all — it relies only on POSIX shell fd-redirection
operators (`3>&1 1>&2`), which are portable across `sh`, `bash`, `dash`, and
`zsh`. Hardened containers without `/proc` are also covered.

**Acceptance test `stdout_purity_60s_smoke` (revised):**

- `console.log("HELLO")` from `src/channel/router.ts` MUST appear on the
  parent's fd 2 (stderr), MUST NOT appear in the MCP frame stream on fd 1.
- `fs.writeSync(1, "RAW")` from a test helper MUST also land on the
  parent's fd 2. This is the **fd-level assertion** that proves the kernel
  redirect (not just the JS swap) is in place.
- The CI smoke harness (`scripts/smoke-stdout.mjs`) spawns the wrapper, not
  `node` directly, on Linux x64 + macOS x64 + macOS arm64 with the same
  assertions.

**Failure mode (unchanged):** if the smoke fails on any of the 3 platforms
during the FIRST PR of the build sequence, the plan auto-converts to
**Option C** (sidecar). The ADR records this branch.

#### Step 2 — Per-project DB prefix (mitigates pre-mortem b)

- `src/util/paths.ts`:

  ```ts
  export function dbFilePrefix(): string {
    const home = os.homedir();
    const stateHome = process.platform === 'darwin'
      ? path.join(home, 'Library/Application Support')
      : (process.env.XDG_STATE_HOME ?? path.join(home, '.local/state'));
    const seed = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
    const projectHash = base32Crockford(
      createHash('sha256').update(seed).digest()
    ).slice(0, 12).toLowerCase();
    return path.join(stateHome, 'claude-simplex-channel', projectHash, 'db');
  }
  ```

- `base32Crockford` uses alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
  (excludes `1`, `I`, `L`, `O`).
- Test `db_prefix_isolated_per_project_dir`: set `CLAUDE_PROJECT_DIR=/A`
  then `/B`, assert two distinct prefixes (12-char project hash differs).

#### Step 3 — SimpleX adapter bring-up

- Lazy `import('simplex-chat')` inside `simplex/adapter.ts`, AFTER stdout gate
  installed.
- Use `bot.run({ filePrefix: dbFilePrefix(), key: process.env.SIMPLEX_DB_PASSPHRASE, ... })`.
- Subscribe to: `NewChatItems`, `ContactConnected`, `ContactUpdated`,
  `ReceivedContactRequest`. (Open question Q2 resolved: separate event, see
  EVENTS.md §ReceivedContactRequest.)
- **Explicit accept** chosen for v1 (Open question Q3):
  use `APIAcceptContact` rather than `addressSettings.autoAccept`, so the
  pairing-code mint can run BEFORE accepting the connection. Auto-accept is
  out of scope for v1.

#### Step 4 — Owner store + first-launch rescue code (S3)

- On first launch, if `~/.claude/channels/simplex/owner.json` is absent:
  - Mint 8-char Crockford base32 rescue code:
    `randomBytes(5)` → base32 → all 8 chars (5 bytes = 40 bits = 8 base32 chars exactly), uppercase.
  - Write `{ ownerContactId: null, ownerProfileSha256: null, createdAt: <ISO>,
    rescueCodeHash: bcrypt(plain, 12) }` to disk with 0600 perms.
  - Print exactly once on stderr:
    `RESCUE CODE (first-launch, save it now): XXXXXXXX`.
  - Never log the plain code at INFO+ (logger refuses it). Never echo it in
    any MCP message. Never persist plain text.
- Tests: `incognito_repair_does_not_grant_owner` (no owner.ownerContactId →
  inbound DM stays in allowlist limbo, cannot emit verdict);
  `db_wipe_then_repair_requires_rescue_code` (delete owner.json + DB →
  fresh rescue code minted; old contacts cannot bind without it).

#### Step 5 — Pairing (NO MCP tool, S4)

- Adapter on `ReceivedContactRequest`:
  1. Generate `pairCode = randomAlphaNum(6)`, TTL 5 min, single-use, bound to
     `contactReqId`.
  2. `APIAcceptContact(contactReqId)`. On `ContactConnected`:
     - DM the new contact: `Pairing code: ${pairCode}. Have the operator DM this
       code back from their owner contact within 5 minutes.`
     - Emit `notifications/claude/channel` with
       `meta.kind=pairing_prompt`, `meta.pair_code=${pairCode}` (informational
       only; Claude has no tool to act).
- Adapter on `NewChatItems` from current owner whose body matches
  `^[A-Z0-9]{6}$`:
  - Look up `pairCode` in store. If found and not expired and not consumed:
    - Mark consumed.
    - Add `(contactId, profileSha256)` of the *originating* connection to
      allowlist.
  - **Collision policy:** lookup is `pairCodeStore.findByCode(text)` which
    returns at most one match. If the 6-char alnum space (≈2.2 × 10⁹) ever
    collides — i.e., two outstanding unconsumed `pairCode` entries with the
    same value within the 5-minute TTL — both entries are rejected with a
    loud stderr warning (`PAIR_CODE_COLLISION code=XXXXXX consumed=both`),
    and a fresh code is minted for each pending request on the next
    `ReceivedContactRequest` event. The owner is informed via a
    `notifications/claude/channel` with `meta.kind=pairing_collision`.
- Genesis path (no owner yet): the only commit path is `bind owner <RESCUECODE>`
  from any contact (because there is no current owner to DM-back).
- The `McpServer` `tools` capability stays `{}` (declares the namespace) but
  `ListTools` returns ONLY `reply` (and optional `mark_read`). NO
  `pair_contact`.

#### Step 6 — `reply` tool

- Standard `ListTools` + `CallTool` per the bible. Schema:
  `{ chat_id: string, text: string }`. `chat_id` resolves to `contactId`;
  outbound via `APISendMessages` with `ChatRef = direct contactId`.

#### Step 7 — Permission relay request handler

- `setNotificationHandler` for `notifications/claude/channel/permission_request`.
- On hit: store `pendingPermReqs.set(request_id.toLowerCase(), { expiresAt:
  now + 5min, requestId: request_id })`. **Single-threaded event loop (Node)
  → no TOCTOU between regex-match and lookup**: state is mutated only from
  the same event-loop turn that performs the lookup. The router is a
  synchronous function; awaits happen only after the verdict decision is
  finalized.
- DM owner: `Claude wants to run ${tool_name}: ${description}\n\nReply "yes
  ${request_id}" or "no ${request_id}"`.
- Implementation MUST keep `handleInbound` synchronous through the verdict
  decision; any `await` (e.g., `ownerStore.matches`) must be moved to a
  synchronous in-memory cache that is refreshed via `ContactUpdated` events,
  not awaited inside the router.

#### Step 8a — Inbound regex match → lookup or forward (S1)

- Router pseudocode:

  ```ts
  // src/channel/router.ts
  const RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;
  function handleInbound(msg: InboundMsg): Action {
    if (!ownerGate(msg.from)) return { kind: 'drop' };          // S3
    const m = RE.exec(msg.text);
    if (!m) return forwardChat(msg);                             // not a verdict shape
    const id = m[2].toLowerCase();
    const pending = pendingPermReqs.get(id);
    if (!pending) return forwardChat(msg);                       // 8a: no match -> chat
    return emitVerdict(id, m[1].toLowerCase().startsWith('y'));  // 8b: owner-only
  }
  ```

- Tests: `permission_regex_without_pending_forwards_as_chat` (regex matches
  but `pendingPermReqs` empty → assert chat notification emitted, no verdict);
  `permission_id_mismatch_forwards_as_chat` (regex matches with id
  `aaaaa` but pending has only `bbbbb` → assert chat notification, no
  verdict).

#### Step 8b — Owner-gated verdict emission (S1)

- Emission only if (i) regex match, (ii) `pendingPermReqs` hit, (iii) sender
  is current owner tuple. Final guard inside `emitVerdict`:

  ```ts
  if (!ownerStore.matches(msg.from.contactId, msg.from.profileSha256)) {
    return forwardChat(msg);
  }
  await mcp.notification({
    method: 'notifications/claude/channel/permission',
    params: { request_id: id, behavior: allow ? 'allow' : 'deny' },
  });
  pendingPermReqs.delete(id);
  ```

- ownerGate at step 8a is a coarse allowlist check; the tuple-match at 8b is
  the strict ownership verification. The double-check defends against
  allowlisted-but-not-owner contacts attempting to inject verdicts.

#### Step 9 — ContactUpdated demotion

- On `ContactUpdated` for owner contactId with `sha256(toContact.profile) !=
  ownerProfileSha256`:
  - Set `owner.ownerContactId = null`, `owner.ownerProfileSha256 = null`.
  - Mint a new rescue code (rotation), bcrypt-hash, persist.
  - Print on stderr: `OWNER PROFILE CHANGED — demoted to allowlist. New rescue
    code: XXXXXXXX. Re-bind via "bind owner <CODE>".`
- Test: `profile_change_demotes_to_allowlist_pending_rescue` — fake
  `ContactUpdated` with new sha → assert `pendingPermReqs` verdicts from this
  contact are now forwarded, not emitted.

#### Step 10 — Addon-crash policy + warm-restart smoke

- Process on Haskell `error` / libc `abort` / SQLite `SIGBUS` / addon panic:
  Node process exits non-zero. Claude Code's MCP supervisor restarts.
- On restart: `pendingPermReqs` is empty (in-memory). The next
  `permission_request` from Claude Code re-DMs the owner with a fresh id.
- Test `addon_crash_restart_reopens_verdict_window`: integration test that
  - issues a fake `permission_request` (id `aaaaa`),
  - asserts owner DM contains `yes aaaaa`,
  - terminates the process with `SIGSEGV`,
  - waits for restart (supervisor or test harness re-spawn),
  - issues fresh `permission_request` (id `bbbbb`),
  - asserts new owner DM contains `yes bbbbb`,
  - DMs `yes bbbbb` from owner, asserts verdict emitted.

---

## 9. Test plan (verbatim names)

### Unit

- `stdout_purity_60s_smoke` *(integration but listed here for visibility — gates plan in step 1.5)*
- `db_prefix_isolated_per_project_dir`
- `permission_regex_without_pending_forwards_as_chat`
- `permission_id_mismatch_forwards_as_chat`
- `incognito_repair_does_not_grant_owner`
- `db_wipe_then_repair_requires_rescue_code`
- `profile_change_demotes_to_allowlist_pending_rescue`
- `simultaneous_pair_codes_unique_per_connection`

### Integration / e2e

- `addon_crash_restart_reopens_verdict_window`
- `warm_restart_resubscribes_within_Ns`

### Operator-facing acceptance (manual)

- First launch on a fresh box prints rescue code on stderr exactly once.
- DM `bind owner <CODE>` from any contact promotes that contact.
- Re-launch with existing `owner.json` does NOT print the rescue code again.
- `--dangerously-load-development-channels server:simplex` (Open Q4) starts
  the channel.

---

## 10. ADR — Architectural Decision Record

**ID**: ADR-0001
**Date**: 2026-05-08
**Status**: Proposed (iter 2)

### Decision

Adopt **Option A**: a single Node.js MCP stdio server that embeds
`simplex-chat@6.5.x` in-process, with a stdout-purity gate (step 1.5) and
the S1/S2/S3/S4 protocol set described above.

### Drivers

1. Operator simplicity (one binary, one supervisor).
2. Stdout-purity must be empirically provable on 3 platforms.
3. Trust boundary auditability across reconnects, profile changes, DB wipes.

### Alternatives considered

- **Option B** (two-process MCP + child CLI over WS): kept warm as a
  documented next pivot if Option C operator burden proves too high.
- **Option C** (sidecar daemon + thin MCP shim): **automatic escalation
  target** if step 1.5's empirical smoke fails on linux-x64, macos-x64, OR
  macos-arm64.

### Why chosen

A is the smallest viable surface for v1 if and only if the addon respects
fd-1 silence. Step 1.5 produces empirical proof in the FIRST PR of the build
sequence. Until that PR lands, A is conditional; if it fails, the plan
converts to C without re-litigating.

### Consequences

- One npm package to ship; one process to monitor.
- **Addon crash policy** (explicit): Haskell `error`, libc `abort`,
  SQLite `SIGBUS`, or addon panic terminates the MCP process. Claude Code's
  MCP supervisor restarts it. In-flight `pendingPermReqs` are lost; the next
  permission request from Claude after restart re-DMs the owner. After addon
  restart, SimpleX SMP/XFTP subscriptions are warm-restored from SQLite within
  N seconds (N to be measured in pilot). Covered by integration test
  `warm_restart_resubscribes_within_Ns` (see §9).
- Owner identity is bound to `(contactId, profileSha256)` and rotates on
  profile change. Rescue code stored bcrypt-hashed; printed once on stderr;
  never logged at INFO+; never echoed in MCP frames.
- No model-callable pairing tool. Genesis = stderr rescue code; ongoing =
  DM-back from current owner. There is no other re-add path.
- Per-project DB prefix isolates concurrent Claude sessions in different
  project dirs.
- Step 1.5 is gated on empirical proof produced by the FIRST PR of the build
  sequence. Since this iteration cannot actually run the smoke against
  `simplex-chat@6.5.x`, the plan auto-escalates to Option C if that PR's
  smoke fails on any of the 3 target platforms. This is recorded here so the
  Critic can verify the escalation contract is in writing.

### Follow-ups

- Pilot with one operator for 2 weeks; collect addon-crash frequency.
- Consider Option B as a v2 if Option C operator burden surfaces.
- Add `mark_read` tool once basic flow is stable.
- Multi-owner / group support: explicitly out of scope, future ADR.

---

## 11. Open questions — resolutions

| # | Question | Resolution |
|---|---|---|
| Q1 | Does `bot.run.onMessage` fire for our own outbound (loopback)? | **Defer.** Lib source not authoritative on this; EVENTS.md does not state. Add bring-up integration test in step 3 that issues `APISendMessages` then logs every `NewChatItems` for 5s — observe & document. Track as follow-up issue label `simplex-loopback-behavior`. |
| Q2 | `receivedContactRequest` shape: callback option vs `chat.on(...)` vs `onMessage`? | **Resolved.** EVENTS.md §ReceivedContactRequest confirms it is a separate event, fired only when auto-accept is disabled (which is our v1 choice — see Q3). The lib exposes it via the standard event subscription path; our adapter subscribes through the same surface as `NewChatItems`. |
| Q3 | Canonical accept: `APIAcceptContact(connReqId)` vs `addressSettings.autoAccept`? | **Resolved.** Use **explicit `APIAcceptContact`** (COMMANDS.md §APIAcceptContact). Consequence: pairing-code mint runs before accept, allowing per-connection codes. Auto-accept is out of scope for v1. |
| Q4 | `--dangerously-load-development-channels server:simplex=node ./dist/index.js` syntax? | **Defer with bounded spike.** Add a 30-min spike task in PR 1 to validate the literal syntax against the bible's accepted forms (`server:<server-name>` only). README will document the validated form once the spike resolves. |
| Q5 | `pair_contact` as MCP tool vs operator-only? | **Resolved.** No MCP tool. DM-back from current owner only. Genesis via stderr rescue code only (S4). |

All Q1–Q5 either resolved with doc reference or explicitly deferred with a
written rationale and a labeled follow-up. The deferred items (Q1, Q4) do
not block the build sequence.

---

## Re-review checklist (Critic-facing)

1. Build sequence diff: BEFORE 8 steps → AFTER 11 steps (1.5, 8a, 8b inserted; step 5 rewritten under S3/S4). **§8.**
2. Principles updated: principle 3 replaced (S3); principle 5 added (S4 — no model-callable pairing). **§2.**
3. `tools: {}` declaration shown post-S4: capability namespace declared but `ListTools` returns only `reply` (and optional `mark_read`); no `pair_contact`. **§8 step 1, §8 step 5, §8 step 6.**
4. Test plan with verbatim names. **§9.**
5. ADR Consequences updated with addon-crash policy paragraph. **§10.**
6. All 5 open questions resolved or explicitly deferred with rationale. **§11.**
7. Step 1.5 gate framed honestly: smoke runs in PR 1 of the build sequence; plan auto-converts to Option C on failure. **§4, §8 step 1.5, §10 Consequences.**

📂 Plan: `/Users/obeone/Documents/geek/github/claude-simplex-channel/.omc/plans/v2-claude-simplex-channel.md`
