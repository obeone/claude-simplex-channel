/**
 * stdout_purity_60s_smoke — vitest wrapper around scripts/smoke-stdout.mjs.
 *
 * Per v2 plan §9, this test name is verbatim. It shells out to the smoke
 * harness, asserts exit code 0, and verifies the JSON artifact reports
 * `pass: true`. The harness itself is the source of truth; this wrapper
 * only exists so CI can run `npm test` and get the gate as a vitest line.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");

describe("stdout_purity_60s_smoke", () => {
  // 60s idle + 5s raw + spawn overhead -> generous 120s upper bound.
  it(
    "runs the smoke harness and observes zero bytes on child fd 1",
    () => {
      execFileSync("npm", ["run", "smoke:stdout"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      });

      const artifactPath = resolve(
        REPO_ROOT,
        `.smoke/stdout-purity-${process.platform}-${process.arch}.json`,
      );
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));

      expect(artifact.pass).toBe(true);
      expect(artifact.bytes).toBe(0);
      expect(artifact.os).toBe(process.platform);
      expect(artifact.arch).toBe(process.arch);
    },
    { timeout: 120_000 },
  );
});
