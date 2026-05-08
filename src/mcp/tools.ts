/**
 * MCP `reply` tool — v2 plan §8 step 6.
 *
 * The single MCP tool exposed by the server. Per S4 / plan principle 5,
 * `pair_contact` is **explicitly forbidden**: pairing is owner-driven over
 * SimpleX (see `src/channel/pairing.ts`) and never model-callable. If a
 * future PR adds `mark_read`, register it from this module too — keep the
 * `tools` namespace closed to the channel-facing surface.
 *
 * Design notes
 * ------------
 *   - The tool is wired via dependency injection (`ToolsDeps`) so unit tests
 *     can drive `ListTools` / `CallTool` against a stub `api` and stub
 *     allowlist predicate without spinning up the SimpleX bot.
 *   - `chat_id` is a STRING in the tool schema (MCP carries arbitrary JSON
 *     and Claude's tool-arg pipeline preserves the verbatim string from the
 *     `<channel chat_id="...">` tag). We `parseInt(value, 10)` and reject NaN
 *     with `InvalidParams` so a malformed tag never reaches `apiSendMessages`.
 *   - Allowlist gate is synchronous and contactId-only. The owner store's
 *     `matches()` predicate requires a profile sha which the model does not
 *     know; for the outbound path the only legitimate "allowlisted" target
 *     today is the bound owner. Worker-state's PR 5 (pairing) will later
 *     extend the gate to include pair-code-admitted contacts.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChatApi } from "simplex-chat/dist/api.js";
import { T } from "@simplex-chat/types";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { log } from "../util/log.js";

/** Tool name. The contract for `<channel source="simplex">` tag handling. */
export const REPLY_TOOL_NAME = "reply";

/**
 * Tool description. Intentionally short — Claude reads the long-form rules
 * from the server `instructions` string declared in `src/mcp/server.ts`.
 */
const REPLY_DESCRIPTION =
  "Send a text reply to the SimpleX contact identified by `chat_id` (the " +
  "value carried in the inbound <channel chat_id=\"...\"> tag).";

/**
 * Zod schema for `reply` arguments. `chat_id` is a string per plan §8 step 6
 * (we parse to int + range-check inside the handler).
 */
export const ReplyArgsSchema = z.object({
  chat_id: z.string().min(1, "chat_id required"),
  text: z.string().min(1, "text required"),
});

export type ReplyArgs = z.infer<typeof ReplyArgsSchema>;

/**
 * JSON Schema mirror of the zod shape, served via `ListTools`.
 *
 * We hand-write this rather than auto-converting because the SDK's tool
 * `inputSchema` field is a JSON Schema object and Claude reads it directly;
 * a mismatched conversion would silently break tool calls.
 */
const REPLY_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    chat_id: {
      type: "string",
      description:
        "SimpleX direct-contact id, taken verbatim from the inbound " +
        "`<channel chat_id=\"...\">` tag. Numeric value carried as a string.",
    },
    text: {
      type: "string",
      description: "Plain text body to send to the contact.",
    },
  },
  required: ["chat_id", "text"],
  additionalProperties: false,
};

/**
 * Dependencies the tool handler needs at runtime.
 *
 * Injected by `src/index.ts` after `startSimplexAdapter` resolves; the
 * MCP server stays unaware of the simplex-chat module so that unit tests
 * can drive both halves independently.
 */
export interface ToolsDeps {
  /** Live `ChatApi` returned by `startSimplexAdapter`. */
  api: Pick<ChatApi, "apiSendMessages">;
  /**
   * Synchronous allowlist predicate.
   *
   * MUST be sync — the tool handler is async-friendly but the allowlist
   * check itself happens before any await to keep the gate close to
   * the validation step. The owner-store cache provides this in production
   * via `getOwnerSnapshot().ownerContactId === contactId`.
   */
  isAllowedContact: (contactId: number) => boolean;
}

/**
 * Register `ListTools` and `CallTool` handlers on the supplied MCP server.
 *
 * Idempotent? No — calling twice replaces the previously registered handler
 * (SDK behaviour). Production callers invoke this exactly once from
 * `src/index.ts`. Unit tests build a fresh `Server` per case.
 */
export function registerReplyTool(server: Server, deps: ToolsDeps): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log.info({ evt: "list_tools", count: 1 });
    // ONLY `reply`. NEVER `pair_contact` (plan principle 5 / S4): pairing is
    // not model-callable. Re-list only if/when `mark_read` is added in a
    // future PR — and even then, never `pair_contact`.
    return {
      tools: [
        {
          name: REPLY_TOOL_NAME,
          description: REPLY_DESCRIPTION,
          inputSchema: REPLY_INPUT_SCHEMA,
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (name !== REPLY_TOOL_NAME) {
      log.warn({ evt: "call_tool_unknown", tool: name });
      throw new McpError(ErrorCode.MethodNotFound, `tool not found: ${name}`);
    }

    // 1. Argument shape validation. Zod failure → -32602 (per plan).
    const parsed = ReplyArgsSchema.safeParse(req.params.arguments);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? "invalid arguments";
      log.warn({ evt: "reply_invalid_args", issue });
      throw new McpError(ErrorCode.InvalidParams, issue);
    }
    const { chat_id, text } = parsed.data;

    // 2. chat_id → contactId. parseInt rejects NaN with InvalidParams. We
    // also reject leading/trailing whitespace surrogates that parseInt would
    // otherwise tolerate, because the inbound tag value should be a clean
    // numeric string.
    const contactId = Number.parseInt(chat_id, 10);
    if (!Number.isFinite(contactId) || String(contactId) !== chat_id.trim()) {
      log.warn({ evt: "reply_invalid_chat_id", chat_id });
      throw new McpError(ErrorCode.InvalidParams, "invalid chat_id");
    }

    // 3. Allowlist gate. Sync — runs before any await so the decision is
    // unambiguous on the same event-loop turn the tool was invoked. The
    // only currently-allowed contact is the bound owner (worker-state's
    // PR 5 will widen this to include pair-admitted contacts).
    if (!deps.isAllowedContact(contactId)) {
      log.warn({ evt: "reply_unknown_chat_id", contact_id: contactId });
      throw new McpError(ErrorCode.InvalidParams, "unknown chat_id");
    }

    // 4. Outbound. Per plan §8 step 6: ChatRef = direct contactId.
    log.info({ evt: "reply_send", contact_id: contactId, len: text.length });
    await deps.api.apiSendMessages(
      [T.ChatType.Direct, contactId],
      [{ msgContent: { type: "text", text }, mentions: {} }],
    );

    // MCP tool result: empty content array signals success with no payload.
    return { content: [] };
  });
}
