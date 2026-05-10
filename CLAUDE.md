# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`claude-simplex-channel` is a Claude Code MCP stdio server that bridges a local
Claude session to a single SimpleX peer over `simplex-chat@6.5.x`
(single-process Node, embedding the Haskell-built native addon — Option A).
It carries bidirectional chat plus a permission relay for tool prompts
(`Bash` / `Write` / `Edit` / ...).

Authoritative spec: [`docs/plans/v2-claude-simplex-channel.md`](docs/plans/v2-claude-simplex-channel.md).
The plan is treated as a contract — many comments in the source reference
specific plan sections (`§8 step 4`, `S4`, etc.). Read the plan before
making non-trivial changes.

## Common commands

```bash
npm install
npm run build              # tsc -> dist/
npm test                   # vitest run (no watch); single file: npm test -- test/unit/router.test.ts
npm run dev                # tsx src/index.ts (smoke only — bypasses fd dance, will exit 2)
npm run smoke:stdout       # 60s + 5s harness, writes .smoke/stdout-purity-<os>-<arch>.json
./bin/claude-simplex-channel   # canonical launch path
```

Two integration tests are gated behind `SIMPLEX_E2E_HARNESS=1` because they
require a live SimpleX core and a respawn supervisor (kept off CI):

```bash
SIMPLEX_E2E_HARNESS=1 npm test -- test/integration/addon_crash_restart.test.ts
SIMPLEX_E2E_HARNESS=1 npm test -- test/integration/warm_restart.test.ts
```

Without the env flag, both tests `it.skip` with a logged reason.

## Hard invariants — DO NOT BREAK

1. **Stdout purity**: only MCP frames touch fd 1. Every other byte (Haskell
   RTS, libc, SQLite, addon panics, our own logs) MUST land on stderr or
   fd 3. The CLI is launched only through `bin/claude-simplex-channel`,
   which runs `exec node ... 3>&1 1>&2` BEFORE Node starts. The JS-level
   half is `assertStdoutGate()` (must run first in `src/index.ts`) and the
   SDK transport is bound to `fs.createWriteStream(null, { fd: 3 })`.
   Direct `node dist/index.js` trips the gate and exits 2.

2. **Owner identity is a tuple `(contactId, profileSha256)`** bound to a
   bcrypt-hashed rescue code (cost 12). First-connect does NOT grant
   ownership. Genesis path is `bind owner <RESCUECODE>` from any contact
   (8-char Crockford code printed once on stderr at first launch). A
   `ContactUpdated` event with a different sha synchronously demotes
   (`clearOwnerSync`) and rotates the code.

3. **No model-callable pairing**. The only MCP tool advertised is `reply`
   (and possibly `mark_read` later). `pair_contact` is forbidden by S4.
   Pairing happens out-of-band via owner DM-back or the rescue code.

4. **Single-threaded inbound router contract**: in `src/channel/router.ts`,
   `handleInbound` MUST stay synchronous between the verdict regex match
   and `pendingPermReqs.get(id)`. Inserting an await there reopens the
   TOCTOU window that `pendingPermReqs.ts` and `verdict.ts` close by
   design. Same rule for `ownerStore.matches()` — sync, no I/O.

5. **Secret discipline**: plain rescue code printed exactly once on
   stderr (`writeRescueCodeOnce`), never logged at INFO+, never echoed
   in MCP frames. `meta.pair_code` must NOT be quoted back over the
   `reply` tool — this is in the verbatim `INSTRUCTIONS` string in
   `src/mcp/server.ts`, which is part of the operator contract.

## Architecture

### Entrypoint bring-up order (load-bearing)

`src/index.ts` orchestrates startup in a strict sequence — the ordering
itself is the contract; rearranging risks a stdout violation or a
verdict TOCTOU. Read the file's top JSDoc before editing.

1. `assertStdoutGate()` — fence check before ANY `simplex-chat` import.
2. Lazy imports (so the native addon loads after the gate is in place).
3. `loadOwnerStore()` populates the synchronous owner cache.
4. `startSimplexAdapter()` boots the bot and returns a `ChatApi` + event hub.
5. SDK `StdioServerTransport` is constructed against fd 3.
6. `installPermissionRequestHandler()` registers the handler BEFORE
   `server.connect()` so the very first ready frame can dispatch.
7. Inbound 2-step verdict pipeline wired:
   `forwardChat` (chat → `notifications/claude/channel`),
   `setEmitVerdict(makeEmitVerdict(...))`,
   `adapter.events.on("newChatItems", ...)` filtering direct `directRcv` text.
8. `installPairingHandlers` + `installBindHandler` (genesis bind).
9. `installContactUpdatedDemotion` (PR 9).

### Module map

- `src/mcp/` — MCP server build, the single `reply` tool, and the
  `permission_request` notification handler. Stays free of any
  `simplex-chat` import.
- `src/simplex/` — adapter, typed event hub re-publishing the four
  events of interest (`newChatItems`, `contactConnected`,
  `contactUpdated`, `receivedContactRequest`), and the
  `ContactUpdated → owner demotion` wiring.
- `src/owner/` — owner store (sync cache + atomic-write `owner.json`
  at mode 0600 under `~/.claude/channels/simplex/`) and the `bind owner
  <CODE>` parser.
- `src/channel/` — pairing protocol (`PairCodeStore`, `Allowlist`,
  6-char `[A-Z0-9]` codes), pending permission-request store with TTL
  sweep, inbound router (regex `^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i`),
  owner-gated verdict emitter.
- `src/util/` — `stdoutGate`, stderr-only structured logger,
  Crockford-base32 project-hash → SQLite `filePrefix`, canonical
  `profileSha256` (single source of truth — used by owner match,
  pairing admission, and demotion).
- `src/test/stdout_assertions.ts` — `__test_writeRawToStdout()`,
  gated by `SIMPLEX_STDOUT_TEST_RAW=1`, used by the smoke harness to
  prove the kernel-level fence catches NATIVE writes.

### Inbound message decision pipeline

```
newChatItems (direct + directRcv + text)
  → handleInbound (sync)
      → ownerGate (owner OR allowlist by contactId)  → drop if false
      → regex match yes/no <id>                       → forwardChat if not
      → pendingPermReqs.get(id)                       → forwardChat if miss
      → emitVerdict (async, owner-tuple strict match)
          → forwardChat if non-owner (allowlist-only sender)
          → server.notification(permission verdict) + pendingPermReqs.del
```

Anything that doesn't reach a verdict is forwarded as
`notifications/claude/channel` chat — NEVER silently dropped. A duplicate
`yes <id>` from the owner falls through to chat (single-use intent).

### Persistence layout

- Owner identity (config, NOT cache):
  `~/.claude/channels/simplex/owner.json` (mode 0600, atomic
  write-then-rename).
- SimpleX SQLite (state):
  - macOS: `~/Library/Application Support/claude-simplex-channel/<projectHash>/db_{chat,agent}.db`
  - Linux: `${XDG_STATE_HOME:-~/.local/state}/claude-simplex-channel/<projectHash>/db_{chat,agent}.db`
  - `projectHash` = first 12 chars of Crockford-base32(sha256(`CLAUDE_PROJECT_DIR ?? cwd`)),
    lowercased. Per-project isolation prevents subscription cross-talk.
- Pair codes + non-owner allowlist: in-memory only. Process restart
  re-pairs from scratch (rescue code remains as recovery path).

## Testing notes

- Vitest runs across files in the same worker — modules with state
  (`pendingPermReqs`, `router`, `owner/store`) all expose
  `__test_reset()`; call it in `beforeEach`/`afterEach`.
- Verdict tests stub the MCP `Server` as `{ notification: vi.fn() }` —
  no in-memory transport pair needed, because `router.ts` has no MCP
  import and `verdict.ts` only calls `server.notification`.
- The owner store tests pass an override `filePath` to
  `loadOwnerStore(...)`; production callers omit it.

## CI

GitHub Actions runs only the stdout-purity smoke
(`.github/workflows/stdout-smoke.yml`) on `ubuntu-latest`. macOS runners
are dropped from automated CI because macos-13 queues indefinitely on
the GH free tier; darwin-arm64 is validated locally and the canonical
artifact is checked in at `.smoke/stdout-purity-darwin-arm64.json`.
The workflow gates on `pass===true` from the JSON artifact.
