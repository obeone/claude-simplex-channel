import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { registerReplyTool, type ToolsDeps } from "./tools.js";

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
 * namespace declaration. `registerReplyTool` is invoked here so the only
 * tool ever advertised on this server is `reply` — `pair_contact` is
 * forbidden by plan principle 5 / S4.
 *
 * Returns the unconnected `Server`. The caller (`src/index.ts`) wires the
 * stdio transport against fd 3 — see `assertStdoutGate()` for the fence.
 */
export function buildMcpServer(opts: { tools: ToolsDeps }): Server {
  const server = new Server(
    { name: "simplex", version: "0.1.0" },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
          "claude/channel/permission": {},
        },
        // Namespace declared; `registerReplyTool` returns ONLY `reply` from
        // ListTools. NEVER `pair_contact` (per S4).
        tools: {},
      },
      instructions: INSTRUCTIONS,
    },
  );

  registerReplyTool(server, opts.tools);

  return server;
}

export { INSTRUCTIONS };
