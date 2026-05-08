import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { log } from "../util/log.js";

/**
 * Instructions string injected into Claude's system prompt.
 *
 * Verbatim per v2 plan §8 step 1 (lines 257-262 of the plan), including the
 * trailing sentence about never quoting `meta.pair_code` over the `reply`
 * tool. Any wording drift here changes Claude's behavior; treat this string
 * as a contract, not a comment.
 */
const INSTRUCTIONS =
  'Messages arrive as <channel source="simplex" chat_id="...">. Reply ' +
  "with the `reply` tool, passing `chat_id` from the tag. The owner may " +
  "always reply naturally to the bot — only literal `yes <id>` or `no <id>` " +
  "matching an active permission prompt are intercepted as verdicts; " +
  "anything else (including `yes`, `approve it`, or an unknown id) is " +
  "forwarded to you as a normal channel message. Never quote " +
  "`meta.pair_code` back over the `reply` tool — it must reach the operator " +
  "only via stderr / channel notification, not via SimpleX echo to a wrong " +
  "contact.";

/**
 * Build the MCP server instance.
 *
 * Capabilities mirror the v2 plan §8 step 1: both `claude/channel` and
 * `claude/channel/permission` experimental capabilities, plus a `tools`
 * namespace declaration. The namespace is declared so future PRs can add
 * the `reply` tool without renegotiating capabilities; for PR 1 the
 * `ListTools` handler returns an empty array.
 *
 * Returns the unconnected `Server`. The caller (`src/index.ts`) wires the
 * stdio transport against fd 3 — see `assertStdoutGate()` for the fence.
 */
export function buildMcpServer(): Server {
  const server = new Server(
    { name: "simplex", version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        // Namespace declared; ListTools returns ONLY `reply` (and optional
        // `mark_read`) in later PRs. NEVER `pair_contact` (per S4).
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  // PR 1: no tools yet. ListTools returns []; CallTool always rejects.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    log.info({ evt: "list_tools", count: 0 });
    return { tools: [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    log.warn({ evt: "call_tool_unknown", tool: name });
    // Standard JSON-RPC method-not-found shape per MCP error conventions.
    throw Object.assign(new Error(`tool not found: ${name}`), {
      code: -32601,
    });
  });

  return server;
}

export { INSTRUCTIONS };
