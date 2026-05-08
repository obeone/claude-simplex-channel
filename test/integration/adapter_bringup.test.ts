/**
 * Integration test for `src/simplex/adapter.ts` bring-up wiring.
 *
 * The full bring-up requires the simplex-chat native addon and live SMP
 * relays — out of scope for CI. Instead we vi.mock('simplex-chat') with a
 * fake `bot.run` that captures the dbOpts/options/events handed to it,
 * returns a fake [api, user, address] tuple, and then asserts:
 *
 *   - bot.run is called with `dbOpts.type=sqlite`, `filePrefix=dbFilePrefix()`.
 *   - addressSettings.autoAccept is FALSE (Q3: explicit accept).
 *   - The four events of interest are subscribed.
 *   - The address banner is written to stderr exactly once.
 *   - onReady is called with the address, db_path, owner_status="unbound".
 *   - Forwarding from the simplex subscriber map into ChannelEventHub works
 *     (firing the captured `newChatItems` subscriber dispatches to a hub
 *     listener registered by the test).
 *
 * This is the contract worker-mcp / worker-owner depend on; if any of these
 * change shape, downstream PRs break loudly here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture references to the most-recent fake `bot.run` invocation so the
// test can introspect what the adapter passed in.
type RunCall = {
  profile: unknown;
  dbOpts: { type: string; filePrefix: string; encryptionKey?: string };
  options: { addressSettings?: { autoAccept?: boolean } };
  events: Record<string, (e: unknown) => unknown>;
};

let lastRunCall: RunCall | undefined;

vi.mock("simplex-chat", () => {
  const fakeUser = { userId: 42, agentUserId: "u42", userContactId: 1 };
  const fakeAddress = {
    userContactLinkId: 1,
    connLinkContact: {
      connFullLink: "simplex:/contact#test-fake-link",
    },
    shortLinkDataSet: false,
    shortLinkLargeDataSet: false,
    addressSettings: { autoAccept: false },
  };
  return {
    bot: {
      run: vi.fn(async (cfg: RunCall) => {
        lastRunCall = cfg;
        return [{}, fakeUser, fakeAddress];
      }),
    },
  };
});

const TEST_PROJECT_DIR = "/tmp/__adapter_bringup_test__";
const ENV_KEY = "CLAUDE_PROJECT_DIR";
const original = process.env[ENV_KEY];

beforeEach(() => {
  process.env[ENV_KEY] = TEST_PROJECT_DIR;
  lastRunCall = undefined;
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
  vi.restoreAllMocks();
});

describe("adapter_bringup", () => {
  it("wires bot.run with dbFilePrefix(), explicit-accept, and the four events", async () => {
    const { startSimplexAdapter } = await import("../../src/simplex/adapter.js");
    const { dbFilePrefix } = await import("../../src/util/paths.js");
    const { ChannelEventHub } = await import("../../src/simplex/events.js");

    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const onReady = vi.fn();
    const events = new ChannelEventHub();

    const handle = await startSimplexAdapter({ onReady, events });

    expect(lastRunCall).toBeDefined();
    expect(lastRunCall!.dbOpts.type).toBe("sqlite");
    expect(lastRunCall!.dbOpts.filePrefix).toBe(dbFilePrefix());
    expect(lastRunCall!.options.addressSettings?.autoAccept).toBe(false);

    // All four events of interest are subscribed in the simplex-chat map.
    const subs = lastRunCall!.events;
    expect(typeof subs.newChatItems).toBe("function");
    expect(typeof subs.contactConnected).toBe("function");
    expect(typeof subs.contactUpdated).toBe("function");
    expect(typeof subs.receivedContactRequest).toBe("function");

    // Address banner printed to stderr exactly once.
    const bannerCalls = stderrWrite.mock.calls.filter((c) =>
      String(c[0]).startsWith("SIMPLEX ADDRESS:"),
    );
    expect(bannerCalls).toHaveLength(1);
    expect(String(bannerCalls[0][0])).toContain("simplex:/contact#test-fake-link");

    // onReady called with the resolved payload.
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith({
      address: "simplex:/contact#test-fake-link",
      db_path: dbFilePrefix(),
      owner_status: "unbound",
    });

    // Forwarding from simplex callback to hub.
    const seen: string[] = [];
    handle.events.on("newChatItems", (e) => {
      seen.push(`items=${e.chatItems.length}`);
    });
    const fakeUser = { userId: 1, agentUserId: "u1", userContactId: 1 };
    await subs.newChatItems({
      type: "newChatItems",
      user: fakeUser,
      chatItems: [],
    });
    expect(seen).toEqual(["items=0"]);
  });
});
