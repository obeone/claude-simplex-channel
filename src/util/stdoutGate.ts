import * as fs from "node:fs";

/**
 * Assert at startup that fd 3 is open and writable.
 *
 * The wrapper `bin/claude-simplex-channel` performs `3>&1 1>&2` before
 * exec'ing Node, so fd 3 is the original stdout (the MCP frame channel)
 * and fd 1 is collapsed onto stderr. If we got launched directly via
 * `node dist/index.js` instead of through the wrapper, fd 3 will not be
 * open and any MCP write would silently land on the wrong sink.
 *
 * On failure we emit a one-line FATAL on stderr and exit with code 2.
 * Exit 2 is reserved for "operator misconfiguration" (vs 1 = runtime).
 */
export function assertStdoutGate(): void {
  try {
    fs.fstatSync(3);
  } catch {
    process.stderr.write(
      "FATAL: fd 3 not open — launch via bin/claude-simplex-channel, not `node` directly.\n",
    );
    process.exit(2);
  }
}
