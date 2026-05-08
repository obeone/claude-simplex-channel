/**
 * Unit tests for `src/util/paths.ts`.
 *
 * Verbatim test name `db_prefix_isolated_per_project_dir` per v2 plan §9.
 * The contract under test: changing `CLAUDE_PROJECT_DIR` MUST yield a
 * different `dbFilePrefix()` so two Claude projects opened on the same host
 * never share SimpleX SQLite storage (mitigates pre-mortem item b).
 */
import { afterEach, describe, expect, it } from "vitest";

import { dbFilePrefix, projectHash } from "../../src/util/paths.js";

const ENV_KEY = "CLAUDE_PROJECT_DIR";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = original;
  }
});

describe("db_prefix_isolated_per_project_dir", () => {
  it("yields distinct prefixes for distinct CLAUDE_PROJECT_DIR values", () => {
    process.env[ENV_KEY] = "/A";
    const prefixA = dbFilePrefix();

    process.env[ENV_KEY] = "/B";
    const prefixB = dbFilePrefix();

    expect(prefixA).not.toBe(prefixB);
    // Both end in `/db` (the literal prefix segment), and differ only in the
    // 12-char project-hash component.
    expect(prefixA.endsWith("/db")).toBe(true);
    expect(prefixB.endsWith("/db")).toBe(true);
  });

  it("produces a deterministic 12-char lowercase Crockford project hash", () => {
    const hash = projectHash("/A");
    expect(hash).toHaveLength(12);
    expect(hash).toBe(hash.toLowerCase());
    // Crockford alphabet (lowercased) excludes `i`, `l`, `o`, `u`. We exclude
    // the first three by construction; `u` never appears in the standard
    // Crockford encode alphabet either, so the regex below covers both.
    expect(hash).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{12}$/);
  });

  it("is stable for the same seed across calls", () => {
    process.env[ENV_KEY] = "/some/repo";
    expect(dbFilePrefix()).toBe(dbFilePrefix());
  });
});
