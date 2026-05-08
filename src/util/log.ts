/**
 * Stderr-only structured logger.
 *
 * Channel-side invariant: nothing the channel emits ever touches fd 1; that
 * fence is held both by the wrapper (kernel-level redirect) and by this
 * module never importing or referencing `process.stdout`. All log output
 * goes to fd 2 as a single JSON line, terminated by `\n`.
 *
 * Secret discipline (enforced more tightly in later PRs):
 *   - Do NOT pass plaintext rescue codes, bcrypt salts, or DB passphrases
 *     at INFO+; reserve those for one-shot stderr writes from the owner
 *     store, never via the structured logger.
 */
export type LogLevel = "info" | "warn" | "error";

export interface LogFields {
  /** Short event name (snake_case). Required. */
  evt: string;
  /** Free-form additional fields. Avoid PII / secrets. */
  [key: string]: unknown;
}

function emit(level: LogLevel, fields: LogFields): void {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    ...fields,
  };
  // Single JSON line + LF, written via fd 2 only.
  process.stderr.write(JSON.stringify(record) + "\n");
}

export const log = {
  info(fields: LogFields): void {
    emit("info", fields);
  },
  warn(fields: LogFields): void {
    emit("warn", fields);
  },
  error(fields: LogFields): void {
    emit("error", fields);
  },
};
