/**
 * MCP `reply` tool unit tests — PR 6, plan §8 step 6.
 *
 * Verbatim test names mandated by the task spec:
 *   - reply_validates_chat_id_in_allowlist
 *   - reply_sends_text_to_contact
 *   - pair_contact_tool_does_not_exist
 *
 * Strategy: build a fresh `Server` per case via `buildMcpServer({ tools })`,
 * then drive `ListTools` and `CallTool` through the in-process MCP client
 * (`@modelcontextprotocol/sdk/client`) so the request handlers run with
 * realistic JSON-RPC framing, including SDK-side error code preservation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { T } from "@simplex-chat/types";

import { buildMcpServer } from "../../src/mcp/server.js";

interface SendCall {
  chat: unknown;
  messages: unknown;
}

let sendCalls: SendCall[];
let allowed: Set<number>;

function makeApi() {
  return {
    apiSendMessages: vi.fn(async (chat: unknown, messages: unknown) => {
      sendCalls.push({ chat, messages });
      return [];
    }),
  };
}

async function buildPair(deps: {
  api: ReturnType<typeof makeApi>;
  isAllowedContact: (id: number) => boolean;
}) {
  const server = buildMcpServer({ tools: deps });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tool-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

beforeEach(() => {
  sendCalls = [];
  allowed = new Set<number>();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reply tool", () => {
  it("pair_contact_tool_does_not_exist", async () => {
    const api = makeApi();
    const { client } = await buildPair({
      api,
      isAllowedContact: (id) => allowed.has(id),
    });

    const list = await client.listTools();
    // ListTools returns ONLY `reply`. NO `pair_contact`. (S4 / plan §8 step 6.)
    expect(list.tools).toHaveLength(1);
    expect(list.tools[0].name).toBe("reply");
    expect(list.tools.find((t) => t.name === "pair_contact")).toBeUndefined();
  });

  it("reply_validates_chat_id_in_allowlist", async () => {
    const api = makeApi();
    // Owner contact 100 is allowed; the test calls with 999 (unknown).
    allowed.add(100);
    const { client } = await buildPair({
      api,
      isAllowedContact: (id) => allowed.has(id),
    });

    let caught: { code?: number; message?: string } | undefined;
    try {
      await client.callTool({
        name: "reply",
        arguments: { chat_id: "999", text: "hello" },
      });
    } catch (err) {
      caught = err as { code?: number; message?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe(ErrorCode.InvalidParams);
    expect(caught!.message).toContain("unknown chat_id");
    // Critical: NO send happened on rejection.
    expect(api.apiSendMessages).not.toHaveBeenCalled();
    expect(sendCalls).toHaveLength(0);
  });

  it("reply_sends_text_to_contact", async () => {
    const api = makeApi();
    allowed.add(100);
    const { client } = await buildPair({
      api,
      isAllowedContact: (id) => allowed.has(id),
    });

    const result = await client.callTool({
      name: "reply",
      arguments: { chat_id: "100", text: "hi there" },
    });
    expect(result.content).toEqual([]);
    expect(api.apiSendMessages).toHaveBeenCalledTimes(1);
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].chat).toEqual([T.ChatType.Direct, 100]);
    expect(sendCalls[0].messages).toEqual([
      { msgContent: { type: "text", text: "hi there" }, mentions: {} },
    ]);
  });

  it("rejects non-numeric chat_id with InvalidParams and does not send", async () => {
    const api = makeApi();
    allowed.add(100);
    const { client } = await buildPair({
      api,
      isAllowedContact: (id) => allowed.has(id),
    });

    let caught: { code?: number; message?: string } | undefined;
    try {
      await client.callTool({
        name: "reply",
        arguments: { chat_id: "not-a-number", text: "x" },
      });
    } catch (err) {
      caught = err as { code?: number; message?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe(ErrorCode.InvalidParams);
    expect(caught!.message).toContain("invalid chat_id");
    expect(api.apiSendMessages).not.toHaveBeenCalled();
  });

  it("rejects unknown tool name with MethodNotFound", async () => {
    const api = makeApi();
    const { client } = await buildPair({
      api,
      isAllowedContact: () => true,
    });

    let caught: { code?: number; message?: string } | undefined;
    try {
      await client.callTool({
        name: "pair_contact",
        arguments: { hint: "should not exist" },
      });
    } catch (err) {
      caught = err as { code?: number; message?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.code).toBe(ErrorCode.MethodNotFound);
  });
});
