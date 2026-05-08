/**
 * addon_crash_restart_reopens_verdict_window — v2 plan §8 step 10 + §9.
 *
 * Verifies the closing PR's contract: a SIGSEGV of the channel process
 * loses in-flight `pendingPermReqs`, the supervisor respawns, the next
 * `permission_request` from Claude re-DMs the owner with a fresh id, and
 * an owner verdict on that fresh id is emitted as a verdict notification.
 *
 * Honest gating per the plan §10 ADR Consequences: this test requires a
 * live SimpleX core, a bound owner, and an external respawn supervisor.
 * Faking any of those three would prove only that the fake was wired —
 * not that the real crash policy holds. So the test is `it.skip` unless
 * `SIMPLEX_E2E_HARNESS=1` is set, in which case the operator is expected
 * to have already paired and to have the wrapper running under a respawn
 * loop (e.g. `while :; do ./bin/claude-simplex-channel || sleep 1; done`).
 *
 * The skipped path still prints a single-line stderr summary so an
 * operator running `npm test` knows exactly what they would need to do
 * to actually exercise the gate.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const HARNESS_FLAG = "SIMPLEX_E2E_HARNESS";
const ENABLED = process.env[HARNESS_FLAG] === "1";

/**
 * Run a child shell pipeline that exercises the supervisor respawn flow.
 *
 * The harness assumes:
 *   - `bin/claude-simplex-channel` is built (`npm run build`).
 *   - `SIMPLEX_DB_PASSPHRASE` is set if the operator's DB is encrypted.
 *   - `SIMPLEX_E2E_OWNER_CONTACT_ID` points at a paired owner.
 *
 * The shell side of this test owns: spawn → fake-permission-request inject →
 * SIGSEGV → wait-for-respawn → second fake-permission-request inject →
 * await owner DM → assert verdict bytes on fd 3.
 *
 * For v1 we ship the JS skeleton + the env-gated assertion; the shell
 * pipeline is documented in README.md ("End-to-end smoke for the crash
 * policy") so the operator can drive it manually. The JS test is the
 * machine-checkable wrapper around the operator's run.
 */
async function runHarness(): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveRun, rejectRun) => {
    const harness = resolve(REPO_ROOT, "scripts/e2e/addon-crash-restart.sh");
    const child = spawn("sh", [harness], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      resolveRun({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        code,
      });
    });
  });
}

describe("addon_crash_restart_reopens_verdict_window", () => {
  it.skipIf(!ENABLED)(
    "owner DM rotates from yes aaaaa to yes bbbbb across SIGSEGV-respawn",
    async () => {
      const result = await runHarness();
      // The harness prints one of two sentinel lines on its last stderr line:
      //   ADDON_CRASH_RESTART: PASS request_id_post=bbbbb verdict_emitted=true
      //   ADDON_CRASH_RESTART: FAIL reason=<...>
      const lastLine = result.stderr
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("ADDON_CRASH_RESTART:"))
        .pop();
      expect(lastLine, `harness stderr: ${result.stderr}`).toBeDefined();
      expect(lastLine).toMatch(/^ADDON_CRASH_RESTART: PASS /);
      expect(result.code).toBe(0);
    },
    { timeout: 60_000 },
  );

  if (!ENABLED) {
    // Print once so an operator running `npm test` sees what's missing.
    process.stderr.write(
      `addon_crash_restart_reopens_verdict_window: SKIPPED — set ${HARNESS_FLAG}=1 ` +
        `with a paired owner + supervisor running ./bin/claude-simplex-channel ` +
        `under a respawn loop. See README "Operational behavior".\n`,
    );
  }
});
