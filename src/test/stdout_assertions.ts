import * as fs from "node:fs";

/**
 * Test-mode helper: deliberately write raw bytes to fd 1 from inside the
 * server process, gated by the env flag `SIMPLEX_STDOUT_TEST_RAW=1`.
 *
 * The smoke harness relies on this to prove the kernel-level redirect
 * (wrapper `3>&1 1>&2`) actually catches NATIVE writes — not just JS
 * `process.stdout.write` swaps. If the wrapper is in place, these bytes
 * land on the parent's stderr; if it is missing, they corrupt the MCP
 * frame stream and the smoke fails loudly.
 *
 * Module-level: zero side effects. Caller must explicitly invoke
 * `__test_writeRawToStdout()` AND have the env flag set.
 */
export function __test_writeRawToStdout(payload: string = "RAW"): void {
  if (process.env.SIMPLEX_STDOUT_TEST_RAW !== "1") {
    return;
  }
  // Bypass the JS Writable layer entirely: this is a libc-level write.
  fs.writeSync(1, payload);
}
