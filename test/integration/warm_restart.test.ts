/**
 * warm_restart_resubscribes_within_Ns — v2 plan §8 step 10 + §9.
 *
 * Measures SimpleX SMP/XFTP resub latency after a clean process restart.
 * Per the plan: warm-restart from SQLite is the contract; the in-flight
 * `pendingPermReqs` is in-memory and intentionally lost, but subscriptions
 * stored in the SQLCipher DB MUST come back within N seconds (placeholder
 * N=30s; refined post-pilot in iter 3 once we have real numbers).
 *
 * Same honest gating as `addon_crash_restart_reopens_verdict_window`: a
 * live SimpleX core + paired owner + supervisor are required, so the JS
 * test is `it.skip` unless `SIMPLEX_E2E_HARNESS=1`. The harness shell
 * script captures the resub timestamps and emits a final stderr line:
 *
 *   WARM_RESTART: PASS resub_latency_ms=<int> threshold_ms=30000
 *   WARM_RESTART: FAIL reason=<...> resub_latency_ms=<int|na>
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const HARNESS_FLAG = "SIMPLEX_E2E_HARNESS";
const ENABLED = process.env[HARNESS_FLAG] === "1";

/** Plan §8 step 10 placeholder. Refined post-pilot. */
const RESUB_THRESHOLD_MS = 30_000;

async function runHarness(): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolveRun, rejectRun) => {
    const harness = resolve(REPO_ROOT, "scripts/e2e/warm-restart.sh");
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

describe("warm_restart_resubscribes_within_Ns", () => {
  it.skipIf(!ENABLED)(
    `SimpleX SMP resub completes within ${RESUB_THRESHOLD_MS}ms post-restart`,
    async () => {
      const result = await runHarness();
      const lastLine = result.stderr
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("WARM_RESTART:"))
        .pop();
      expect(lastLine, `harness stderr: ${result.stderr}`).toBeDefined();
      expect(lastLine).toMatch(/^WARM_RESTART: PASS /);
      const m = lastLine?.match(/resub_latency_ms=(\d+)/);
      expect(m, `expected resub_latency_ms in: ${lastLine}`).toBeTruthy();
      const latencyMs = Number(m![1]);
      expect(Number.isFinite(latencyMs)).toBe(true);
      expect(latencyMs).toBeLessThanOrEqual(RESUB_THRESHOLD_MS);
      // Surface the measurement so the operator can copy it into the
      // pilot-report; iter 3 will tighten the threshold.
      process.stderr.write(
        `warm_restart_resubscribes_within_Ns: measured resub_latency_ms=${latencyMs} ` +
          `threshold_ms=${RESUB_THRESHOLD_MS}\n`,
      );
      expect(result.code).toBe(0);
    },
    { timeout: 90_000 },
  );

  if (!ENABLED) {
    process.stderr.write(
      `warm_restart_resubscribes_within_Ns: SKIPPED — set ${HARNESS_FLAG}=1 ` +
        `with a paired owner + supervisor. See README "Operational behavior".\n`,
    );
  }
});
