/**
 * Per-project filesystem paths for the SimpleX adapter state.
 *
 * The SimpleX bot persists its SQLite databases (`*_chat.db`, `*_agent.db`)
 * under a `filePrefix`. We isolate each Claude project under its own prefix
 * so that two projects opened on the same host (or recovered side-by-side)
 * cannot accidentally cross-talk via shared subscriptions — see the
 * pre-mortem item (b) in `docs/plans/v2-claude-simplex-channel.md` §5.
 *
 * Layout (per v2 plan §8 step 2):
 *   - macOS  → `~/Library/Application Support/claude-simplex-channel/<projectHash>/db`
 *   - Linux  → `${XDG_STATE_HOME:-~/.local/state}/claude-simplex-channel/<projectHash>/db`
 *
 * `projectHash` is the first 12 chars of Crockford-base32(sha256(seed)),
 * lowercased, where `seed` is `process.env.CLAUDE_PROJECT_DIR ?? cwd()`.
 * Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`) excludes the
 * ambiguous glyphs `1`, `I`, `L`, `O` so a hash that ever leaks to a human
 * (logs, stderr) stays unambiguous.
 */
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

/** Crockford base32 alphabet — excludes `1`, `I`, `L`, `O`. */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encode a buffer as Crockford-base32 (no padding, no separators).
 *
 * Streaming 5-bit accumulator: shift each byte into a buffer 8 bits wide,
 * emit a symbol whenever ≥5 bits are queued. Trailing bits (if any) are
 * left-padded with zeros to fill the final 5-bit group. The output length
 * for an N-byte input is `ceil(N * 8 / 5)` symbols.
 */
function base32Crockford(bytes: Uint8Array): string {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const idx = (acc >> bits) & 0x1f;
      out += CROCKFORD_ALPHABET[idx];
    }
  }
  if (bits > 0) {
    const idx = (acc << (5 - bits)) & 0x1f;
    out += CROCKFORD_ALPHABET[idx];
  }
  return out;
}

/**
 * Compute the 12-char lowercase project hash from the seed string.
 *
 * Exposed for tests; production code calls `dbFilePrefix()` instead.
 */
export function projectHash(seed: string): string {
  const digest = createHash("sha256").update(seed).digest();
  return base32Crockford(digest).slice(0, 12).toLowerCase();
}

/**
 * Resolve the SimpleX `filePrefix` for the current project.
 *
 * The returned path is the *prefix* (no extension), suitable for direct
 * passing to `bot.run({ filePrefix })`. The SimpleX runtime appends
 * `_chat.db` / `_agent.db`. Callers are responsible for ensuring the
 * parent directory exists before invoking the bot.
 */
export function dbFilePrefix(): string {
  const home = os.homedir();
  const stateHome =
    process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : (process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"));
  const seed = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  return path.join(stateHome, "claude-simplex-channel", projectHash(seed), "db");
}
