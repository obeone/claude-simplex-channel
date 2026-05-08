/**
 * permission.ts unit tests — PR 7, plan §8 step 7.
 *
 * Drives the registered `setNotificationHandler` end-to-end via the
 * in-memory MCP transport pair, asserting:
 *   - On `permission_request`, the entry lands in `pendingPermReqs`.
 *   - The owner is DM'd with the verbatim verdict-instruction template.
 *   - When no owner is bound, the entry is still registered (so a later
 *     bind + verdict still works inside TTL) but no DM is attempted.
 *   - `buildOwnerDm` produces the exact wording mandated by the plan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { T } from "@simplex-chat/types";

import * as pending from "../../src/channel/pendingPermReqs.js";
import {
  buildOwnerDm,
  installPermissionRequestHandler,
  PERMISSION_REQUEST_METHOD,
} from "../../src/mcp/permission.js";

interface SendCall {
  chat: unknown;
  text: string;
}

let sendCalls: SendCall[];

function makeApi() {
  return {
    apiSendTextMessage: vi.fn(async (chat: unknown, text: string) => {
      sendCalls.push({ chat, text });
      return [];
    }),
  };
}

async function buildPair(deps: {
  api: ReturnType<typeof makeApi>;
  getOwnerContactId: () => number | null;
}) {
  const server = new Server(
    { name: "simplex", version: "0.0.0" },
    { capabilities: { experimental: { "claude/channel/permission": {} } } },
  );
  installPermissionRequestHandler({
    server,
    api: deps.api,
    getOwnerContactId: deps.getOwnerContactId,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "perm-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

beforeEach(() => {
  pending.__test_reset();
  sendCalls = [];
});

afterEach(() => {
  pending.__test_reset();
  vi.restoreAllMocks();
});

describe("permission_request handler", () => {
  it("registers the entry and DMs the bound owner with verbatim text", async () => {
    const api = makeApi();
    const { client } = await buildPair({
      api,
      getOwnerContactId: () => 42,
    });

    await client.notification({
      method: PERMISSION_REQUEST_METHOD,
      params: {
        request_id: "ABcde",
        tool_name: "Bash",
        description: "rm -rf /",
      },
    });

    // Entry stored under lowercased key, original case preserved.
    const entry = pending.get("abcde");
    expect(entry).toBeDefined();
    expect(entry!.requestId).toBe("ABcde");
    expect(entry!.toolName).toBe("Bash");
    expect(entry!.description).toBe("rm -rf /");

    // DM sent to owner with verbatim wording.
    expect(api.apiSendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].chat).toEqual([T.ChatType.Direct, 42]);
    expect(sendCalls[0].text).toBe(
      'Claude wants to run Bash: rm -rf /\n\nReply "yes ABcde" or "no ABcde"',
    );
  });

  it("registers the entry but does not DM when no owner is bound", async () => {
    const api = makeApi();
    const { client } = await buildPair({
      api,
      getOwnerContactId: () => null,
    });

    await client.notification({
      method: PERMISSION_REQUEST_METHOD,
      params: {
        request_id: "fffff",
        tool_name: "Edit",
        description: "edit /etc/hosts",
      },
    });

    expect(pending.get("fffff")).toBeDefined();
    expect(api.apiSendTextMessage).not.toHaveBeenCalled();
  });

  it("buildOwnerDm matches the verbatim template from plan §8 step 7", () => {
    expect(buildOwnerDm("Bash", "rm -rf /", "abcde")).toBe(
      'Claude wants to run Bash: rm -rf /\n\nReply "yes abcde" or "no abcde"',
    );
  });
});
