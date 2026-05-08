/**
 * SimpleX adapter bring-up — v2 plan §8 step 3.
 *
 * Responsibilities of this module:
 *   1. Lazy `import('simplex-chat')` so the native addon load happens AFTER
 *      `assertStdoutGate()` ran in `src/index.ts` (the addon writes to libc
 *      stdout during init; the kernel-level fence must already be in place).
 *   2. Run the bot via `bot.run({ profile, dbOpts: { type: 'sqlite',
 *      filePrefix: dbFilePrefix(), encryptionKey: SIMPLEX_DB_PASSPHRASE } })`.
 *   3. Print the bot's SimpleX address ONCE on stderr at startup (operator
 *      uses it to DM the bot from a phone).
 *   4. Emit a single MCP `notifications/claude/channel` with
 *      `meta.kind=adapter_ready`, carrying `{ address, db_path, owner_status }`
 *      so Claude knows the channel is live and whether an owner is bound.
 *   5. Subscribe to the four events of interest and re-publish them via the
 *      `ChannelEventHub` so PR 5/6/7/8/9 can plug in without re-importing
 *      simplex-chat.
 *
 * Per Q3 resolution in the plan: do NOT use `addressSettings.autoAccept` —
 * we accept contact requests explicitly via `apiAcceptContactRequest` from
 * the pairing layer (PR 5), so a pair-code can be minted BEFORE accept.
 *
 * Per Q1 (loopback observation): when `SIMPLEX_LOOPBACK_OBSERVE_MS` is set,
 * log every `newChatItems` for the configured window after startup. Result
 * documented in the PR commit body.
 */
import type { ChatApi, EventSubscribers } from "simplex-chat/dist/api.js";
import type { CEvt, T } from "@simplex-chat/types";

import { log } from "../util/log.js";
import { dbFilePrefix } from "../util/paths.js";
import { ChannelEventHub } from "./events.js";

/** Default SimpleX bot profile. Display name is intentionally generic. */
const DEFAULT_BOT_PROFILE: T.Profile = {
  displayName: "claude-simplex-channel",
  fullName: "",
};

/** MCP notification payload published once the adapter is ready. */
export interface AdapterReadyPayload {
  /** Bot's SimpleX `connFullLink` (the URI a phone can scan / paste). */
  address: string | null;
  /** Resolved DB filePrefix — useful for operator debugging. */
  db_path: string;
  /** "bound" if an owner exists in the store, else "unbound". */
  owner_status: "bound" | "unbound";
}

/** Result returned from `startSimplexAdapter` for the entrypoint to wire up. */
export interface SimplexAdapterHandle {
  api: ChatApi;
  user: T.User;
  /** May be `undefined` if address creation was skipped or not yet ready. */
  address: T.UserContactLink | undefined;
  events: ChannelEventHub;
  /** Resolved DB filePrefix passed to the bot. */
  filePrefix: string;
}

/**
 * Caller-supplied callback invoked once at startup so the entrypoint can:
 *   (a) decide owner_status from `src/owner/store.ts` (worker-owner), and
 *   (b) emit the MCP notification with the resolved payload.
 *
 * The adapter does not import the owner store directly to avoid a build
 * coupling between PR 3 (this) and PR 4 (owner store).
 */
export type OnAdapterReady = (payload: AdapterReadyPayload) => void | Promise<void>;

export interface StartSimplexAdapterOptions {
  /** Bot profile; defaults to `DEFAULT_BOT_PROFILE`. */
  profile?: T.Profile;
  /** Override DB filePrefix; defaults to `dbFilePrefix()`. */
  filePrefix?: string;
  /** SQLCipher key; defaults to `process.env.SIMPLEX_DB_PASSPHRASE`. */
  encryptionKey?: string;
  /** Called once with the ready payload. Required so the entrypoint can emit MCP notification. */
  onReady: OnAdapterReady;
  /** Optional pre-built event hub (for tests). */
  events?: ChannelEventHub;
}

/**
 * Boot the SimpleX bot and wire its event stream into the `ChannelEventHub`.
 *
 * MUST be called after `assertStdoutGate()`. The dynamic import below is the
 * load-bearing line: if `simplex-chat` were imported at module top, the
 * native addon's libc stdout writes during `node-gyp` boot would race the
 * stdout-gate assertion and could trigger `STDOUT_VIOLATION` in the smoke.
 */
export async function startSimplexAdapter(
  opts: StartSimplexAdapterOptions,
): Promise<SimplexAdapterHandle> {
  const filePrefix = opts.filePrefix ?? dbFilePrefix();
  const encryptionKey = opts.encryptionKey ?? process.env.SIMPLEX_DB_PASSPHRASE;
  const profile = opts.profile ?? DEFAULT_BOT_PROFILE;
  const events = opts.events ?? new ChannelEventHub();

  // Lazy import — the addon's native init can write to fd 1 before the
  // wrapper-level fence is set up otherwise.
  const { bot } = await import("simplex-chat");

  // EventSubscribers map: forward each of the four channel events into the
  // hub. Other simplex events are ignored at this layer (PR 7/8 will subscribe
  // to additional ones if needed).
  const subscribers: EventSubscribers = {
    newChatItems: (event: CEvt.NewChatItems) => events.emit("newChatItems", event),
    contactConnected: (event: CEvt.ContactConnected) =>
      events.emit("contactConnected", event),
    contactUpdated: (event: CEvt.ContactUpdated) =>
      events.emit("contactUpdated", event),
    receivedContactRequest: (event: CEvt.ReceivedContactRequest) =>
      events.emit("receivedContactRequest", event),
  };

  const dbOpts =
    encryptionKey !== undefined
      ? { type: "sqlite" as const, filePrefix, encryptionKey }
      : { type: "sqlite" as const, filePrefix };

  log.info({
    evt: "simplex_bot_starting",
    file_prefix: filePrefix,
    encrypted: encryptionKey !== undefined,
  });

  const [api, user, address] = await bot.run({
    profile,
    dbOpts,
    options: {
      // Q3 resolution: explicit accept from the pairing layer.
      addressSettings: { autoAccept: false },
      createAddress: true,
      updateAddress: false,
      updateProfile: true,
      allowFiles: false,
      logContacts: false,
      logNetwork: false,
    },
    events: subscribers,
  });

  // (3) Print address banner to stderr ONCE. Operators copy this into a
  // SimpleX phone app to start the pairing handshake.
  const fullLink = address?.connLinkContact?.connFullLink ?? null;
  if (fullLink) {
    process.stderr.write(`SIMPLEX ADDRESS: ${fullLink}\n`);
  } else {
    process.stderr.write(
      "SIMPLEX ADDRESS: <pending — bot.run() returned no UserContactLink; check apiCreateUserAddress()>\n",
    );
  }
  log.info({
    evt: "simplex_bot_ready",
    user_id: user.userId,
    address_present: fullLink !== null,
  });

  // (4) Surface ready state to the caller; the entrypoint emits the MCP
  // notification (it owns the McpServer handle).
  await opts.onReady({
    address: fullLink,
    db_path: filePrefix,
    // owner_status filled in by the entrypoint via the owner store; we
    // default to "unbound" here so the adapter alone is testable. The
    // entrypoint MUST overwrite this before emitting the MCP notification.
    owner_status: "unbound",
  });

  // (Q1) Optional 5-second loopback observation: log every newChatItems we
  // see for `SIMPLEX_LOOPBACK_OBSERVE_MS` after startup, so the operator can
  // confirm whether `apiSendMessages` echoes back as a `newChatItems` for
  // the same direction. Result is documented in the commit body.
  const observeMs = parseInt(process.env.SIMPLEX_LOOPBACK_OBSERVE_MS ?? "0", 10);
  if (Number.isFinite(observeMs) && observeMs > 0) {
    const observer = (event: CEvt.NewChatItems): void => {
      log.info({
        evt: "loopback_observe_new_chat_items",
        count: event.chatItems.length,
        sources: event.chatItems.map((ci) => ci.chatInfo.type),
      });
    };
    events.on("newChatItems", observer);
    setTimeout(() => {
      events.off("newChatItems", observer);
      log.info({ evt: "loopback_observe_window_closed", window_ms: observeMs });
    }, observeMs).unref();
  }

  return { api, user, address, events, filePrefix };
}
