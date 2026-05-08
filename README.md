# claude-simplex-channel

> Status: Iteration 2 (patched), PR 1 — MCP skeleton + stdout-purity gate.

A Claude Code channel (MCP stdio server) that bridges Claude's local session
to a single SimpleX peer over `simplex-chat@6.5.x`. Bidirectional chat plus
permission relay (`Bash`/`Write`/`Edit`/...).

See the implementation plan: [`docs/plans/v2-claude-simplex-channel.md`](docs/plans/v2-claude-simplex-channel.md).

## Hard constraints

- **Stdout purity is invariant**: only MCP frames touch fd 1. Everything else
  (Haskell logs, addon prints, our own logs) goes to stderr or fd 3.
- **Owner identity is a tuple**: `(contactId, profileSha256)` bound to a
  bcrypt-hashed rescue code. First-connect does NOT grant ownership.
- **No model-callable pairing**: the only model-facing tool is `reply` (and
  optional `mark_read`). Pairing happens out-of-band via owner DM-back or
  the rescue code.
- **Single-process Node MCP** embedding `simplex-chat@6.5.x` (Option A). The
  plan auto-converts to a sidecar (Option C) if the stdout-purity smoke fails
  on linux-x64 (ubuntu-latest in CI) or darwin-arm64 (validated locally; macos-x64
  dropped from automated CI — macos-13 runners queue indefinitely on GH free tier).

## Quick start

```bash
npm install
npm run build
npm run smoke:stdout
```

The smoke harness writes a JSON artifact under `.smoke/` and a one-line
summary to stderr (`STDOUT_PURITY: PASS|FAIL os=... arch=... bytes=N duration=Xs`).

The CLI itself is launched through a POSIX wrapper, never `node` directly:

```bash
./bin/claude-simplex-channel
```

The wrapper performs the kernel-level fd dance (`3>&1 1>&2`) before exec'ing
Node, so any non-MCP write to fd 1 from libc / Haskell / SQLite lands on
stderr instead of corrupting the MCP frame stream.

## Operational behavior

Haskell error / libc abort / SQLite SIGBUS / addon panic terminates the MCP process. Claude Code's MCP supervisor restarts it. In-flight pendingPermReqs are lost; the next permission request from Claude after restart re-DMs the owner. SimpleX SMP/XFTP subscriptions warm-restart from SQLite.

### End-to-end smoke for the crash policy

The integration tests covering this policy
(`test/integration/addon_crash_restart.test.ts` and
`test/integration/warm_restart.test.ts`) require a live SimpleX core and a
respawn supervisor. They are gated behind `SIMPLEX_E2E_HARNESS=1` so CI
stays green without faking the addon. Run them locally with:

```bash
SIMPLEX_E2E_HARNESS=1 npm test -- test/integration/addon_crash_restart.test.ts
SIMPLEX_E2E_HARNESS=1 npm test -- test/integration/warm_restart.test.ts
```

Without `SIMPLEX_E2E_HARNESS`, both tests `it.skip` with a logged reason
and exit 0 — explicit skip beats a green fake.
