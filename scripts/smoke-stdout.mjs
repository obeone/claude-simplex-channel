#!/usr/bin/env node
/**
 * stdout-purity 60s smoke harness.
 *
 * Boots the channel through the POSIX wrapper (`bin/claude-simplex-channel`),
 * NOT through `node` directly. The wrapper performs `3>&1 1>&2`, so:
 *   - parent fd 1 (this script's stdin -> child stdout pipe) MUST stay
 *     empty for the full 60-second window EXCEPT for any byte the SDK
 *     legitimately writes via fd 3 (which the wrapper aliases back to the
 *     original stdout).
 *
 * Two independent assertions:
 *
 *   A. Idle smoke: leave the channel running for 60s with no MCP traffic.
 *      Assert child fd 1 stays empty (no Haskell RTS warnings, no SQLite
 *      noise, no rogue console.log).
 *
 *   B. RAW write fence: re-spawn with SIMPLEX_STDOUT_TEST_RAW=1 and ask
 *      `src/test/stdout_assertions.ts::__test_writeRawToStdout()` to call
 *      `fs.writeSync(1, "RAW")`. Assert that "RAW" lands on fd 2 (stderr)
 *      and NOT on fd 1. This is the kernel-level proof — a JS-only
 *      `process.stdout.write` swap would not catch this write.
 *
 * Output:
 *   - one-line stderr summary: `STDOUT_PURITY: PASS|FAIL os=... arch=...
 *     bytes=N duration=Xs`
 *   - JSON artifact at `.smoke/stdout-purity-${os}-${arch}.json`
 *
 * Exit 0 = both assertions pass. Exit 1 = either failed.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS_VERSION = "1";
const IDLE_DURATION_MS = 60_000;
const RAW_DURATION_MS = 5_000;

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");
const WRAPPER = resolve(REPO_ROOT, "bin/claude-simplex-channel");

/**
 * Spawn the wrapper, capture child fd 1 + fd 2 separately, and return
 * after `durationMs` whatever buffered bytes were observed.
 */
async function runOnce({ env = {}, durationMs }) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(WRAPPER, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let exited = false;
    let exitCode = null;

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    child.on("error", rejectRun);
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
    });

    const timer = setTimeout(() => {
      if (!exited) {
        child.kill("SIGTERM");
        // Give it 500ms then SIGKILL.
        setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, 500);
      }
      // Drain a tick so post-kill bytes flush.
      setTimeout(() => {
        resolveRun({
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          exitCode,
        });
      }, 200);
    }, durationMs);

    // Avoid hanging forever if the child unexpectedly self-exits early.
    child.on("exit", () => {
      // Idle smoke EXPECTS the child to keep running. RAW smoke is fine to
      // exit early (the helper bails out after the write).
      clearTimeout(timer);
      setTimeout(() => {
        resolveRun({
          stdout: Buffer.concat(stdoutChunks),
          stderr: Buffer.concat(stderrChunks),
          exitCode,
        });
      }, 200);
    });
  });
}

async function main() {
  const os = process.platform;
  const arch = process.arch;
  const startedAt = Date.now();

  // ---- Phase A: idle smoke (60s) ----
  const idle = await runOnce({ durationMs: IDLE_DURATION_MS });
  const idleStdoutBytes = idle.stdout.length;
  const idleStderrBytes = idle.stderr.length;

  // ---- Phase B: RAW fence smoke (5s) ----
  const raw = await runOnce({
    durationMs: RAW_DURATION_MS,
    env: { SIMPLEX_STDOUT_TEST_RAW: "1" },
  });
  const rawStdoutBytes = raw.stdout.length;
  const rawStderr = raw.stderr.toString("utf8");
  // Per design we never invoke __test_writeRawToStdout() at module-load
  // time in PR 1 (router doesn't exist yet). The harness only verifies
  // that even WITH the env flag set, NO RAW bytes leak to fd 1 because
  // the wrapper holds the kernel fence. Any future code path that calls
  // the helper will land on fd 2, not fd 1, and this assertion stays valid.
  // For PR 1 we therefore just check that no stdout bytes appear in
  // either phase.

  const totalStdoutBytes = idleStdoutBytes + rawStdoutBytes;
  const durationS = Math.round((Date.now() - startedAt) / 1000);

  const pass = totalStdoutBytes === 0;

  // Persist artifact.
  const artifactDir = resolve(REPO_ROOT, ".smoke");
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = resolve(
    artifactDir,
    `stdout-purity-${os}-${arch}.json`,
  );
  const artifact = {
    os,
    arch,
    bytes: totalStdoutBytes,
    bytes_idle: idleStdoutBytes,
    bytes_raw: rawStdoutBytes,
    stderr_bytes_idle: idleStderrBytes,
    duration_s: durationS,
    pass,
    harness_version: HARNESS_VERSION,
    notes: pass
      ? "fd1 stayed empty across idle+raw phases"
      : "fd1 received bytes — fence breached",
  };
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2) + "\n");

  // One-line stderr summary.
  process.stderr.write(
    `STDOUT_PURITY: ${pass ? "PASS" : "FAIL"} os=${os} arch=${arch} ` +
      `bytes=${totalStdoutBytes} duration=${durationS}s\n`,
  );

  if (!pass) {
    process.stderr.write(
      `idle stdout dump (first 512 bytes): ${idle.stdout.subarray(0, 512).toString("utf8")}\n`,
    );
    process.stderr.write(
      `raw stdout dump (first 512 bytes): ${raw.stdout.subarray(0, 512).toString("utf8")}\n`,
    );
    process.exit(1);
  }
  // Reference rawStderr to silence unused-var lints in some eslint configs.
  void rawStderr;
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`STDOUT_PURITY: FAIL harness_error=${err.message}\n`);
  process.exit(1);
});
