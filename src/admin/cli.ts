/**
 * Admin CLI for claude-simplex-channel.
 *
 * Invoked via `bin/claude-simplex-channel admin <subcommand>`. Mutates
 * `owner.json` / `allowlist.json` directly; the running MCP server (if
 * any) picks up the changes via the hot-reload watchers wired in
 * `src/index.ts`. Stays separate from the MCP entrypoint so it does
 * not boot the SimpleX adapter or open the SimpleX SQLite database.
 *
 * Stdout shape: every subcommand prints a single JSON document on stdout
 * for machine consumption (slash commands, scripts). Human-facing
 * banners (rescue codes, errors) go to stderr per the secret-discipline
 * invariant — never to stdout, never JSON-encoded.
 *
 * Exit codes:
 *   0  — success
 *   2  — invalid usage / argument validation failed
 *   3  — runtime error (file IO, owner store unloaded, etc.)
 */
import {
  clearOwnerSync,
  getOwnerSnapshot,
  loadOwnerStore,
  rotateAfterDemotion,
  rotateRescueCodeOnly,
} from "../owner/store.js";
import { Allowlist } from "../channel/pairing.js";

interface StatusReport {
  owner: {
    bound: boolean;
    contactId: number | null;
    profileSha256: string | null;
  };
  allowlist: {
    size: number;
    entries: Array<{
      contactId: number;
      profileSha256: string;
      viaPairCode?: string;
      admittedAt: string;
    }>;
  };
}

function emit(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function emitError(message: string, exitCode = 3): never {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

async function loadAllowlist(): Promise<Allowlist> {
  const a = new Allowlist();
  await a.loadFromDisk();
  return a;
}

async function doStatus(): Promise<number> {
  await loadOwnerStore();
  const allowlist = await loadAllowlist();
  const snap = getOwnerSnapshot();
  const report: StatusReport = {
    owner: {
      bound: snap.ownerContactId !== null,
      contactId: snap.ownerContactId,
      profileSha256: snap.ownerProfileSha256,
    },
    allowlist: {
      size: allowlist.size(),
      entries: allowlist.list(),
    },
  };
  emit(report);
  return 0;
}

async function doRevoke(args: string[]): Promise<number> {
  const raw = args[0];
  if (!raw) {
    emitError(
      "usage: claude-simplex-channel admin revoke <contact_id>",
      2,
    );
  }
  const contactId = Number.parseInt(raw, 10);
  if (!Number.isFinite(contactId) || String(contactId) !== raw.trim()) {
    emitError(`invalid contact_id: ${raw}`, 2);
  }
  const allowlist = await loadAllowlist();
  const removed = allowlist.removeByContactId(contactId);
  await allowlist.flush();
  emit({ contact_id: contactId, removed });
  return 0;
}

async function doRotateRescue(): Promise<number> {
  await loadOwnerStore();
  await rotateRescueCodeOnly();
  emit({ rotated: true });
  return 0;
}

async function doUnbind(): Promise<number> {
  await loadOwnerStore();
  const before = getOwnerSnapshot().ownerContactId;
  clearOwnerSync();
  await rotateAfterDemotion();
  emit({ unbound_contact_id: before });
  return 0;
}

function doHelp(): number {
  process.stderr.write(
    [
      "claude-simplex-channel admin <subcommand>",
      "",
      "Subcommands:",
      "  status                 Report owner + allowlist state as JSON.",
      "  revoke <contact_id>    Drop every allowlist entry for the given contactId.",
      "  rotate-rescue          Mint a new rescue code; keep the bound owner.",
      "  unbind                 Clear the bound owner and mint a new rescue code.",
      "",
      "All mutations atomically rewrite their target JSON file at mode 0600.",
      "A running MCP process picks up the changes via fs.watch — no respawn needed.",
      "",
    ].join("\n"),
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [, , subcmd, ...rest] = argv;
  switch (subcmd) {
    case "status":
      return doStatus();
    case "revoke":
      return doRevoke(rest);
    case "rotate-rescue":
      return doRotateRescue();
    case "unbind":
      return doUnbind();
    case undefined:
    case "help":
    case "-h":
    case "--help":
      return doHelp();
    default:
      process.stderr.write(`unknown subcommand: ${subcmd}\n`);
      doHelp();
      return 2;
  }
}

const exitCode = await main(process.argv).catch((err: unknown): number => {
  process.stderr.write(`admin cli failed: ${String(err)}\n`);
  return 3;
});
process.exit(exitCode);
