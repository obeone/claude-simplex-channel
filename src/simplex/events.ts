/**
 * In-process event hub for SimpleX adapter callbacks.
 *
 * The simplex-chat library delivers events through its own subscriber map
 * (`api.EventSubscribers`). The channel core (router, pairing, owner) needs
 * the same events but must stay decoupled from the simplex import chain so
 * unit tests can drive the same code paths without spinning up the bot.
 *
 * This module re-exposes the four events the v2 plan §8 step 3 subscribes to
 * (`newChatItems`, `contactConnected`, `contactUpdated`,
 * `receivedContactRequest`) as a typed event hub. The adapter forwards each
 * raw simplex event into this hub; downstream consumers subscribe via
 * `channelEvents.on(...)`.
 *
 * No persistence. No re-ordering. Listeners run synchronously in registration
 * order; throwing inside a listener propagates to the adapter callback (and
 * thus to the simplex event loop), which is intentional — silent failure
 * inside a router would mask permission-prompt drops.
 */
import type { CEvt } from "@simplex-chat/types";

/**
 * Event payload map. Keys mirror the simplex-chat event tags we subscribe to.
 *
 * We intentionally re-export the simplex types directly rather than projecting
 * a domain model — PR 5/6/7/8 all need the full event shape (contactId,
 * profileSha256 source, chatItem text, etc.) and an over-eager projection
 * would force every later PR to revisit this file.
 */
export interface ChannelEventMap {
  newChatItems: CEvt.NewChatItems;
  contactConnected: CEvt.ContactConnected;
  contactUpdated: CEvt.ContactUpdated;
  receivedContactRequest: CEvt.ReceivedContactRequest;
}

export type ChannelEventTag = keyof ChannelEventMap;

export type ChannelEventListener<K extends ChannelEventTag> = (
  event: ChannelEventMap[K],
) => void | Promise<void>;

/**
 * Tiny typed event hub. Not exported as a singleton to keep tests isolated;
 * `src/simplex/adapter.ts` instantiates one and exports it.
 */
export class ChannelEventHub {
  private readonly listeners: {
    [K in ChannelEventTag]: Set<ChannelEventListener<K>>;
  } = {
    newChatItems: new Set(),
    contactConnected: new Set(),
    contactUpdated: new Set(),
    receivedContactRequest: new Set(),
  };

  on<K extends ChannelEventTag>(tag: K, listener: ChannelEventListener<K>): void {
    this.listeners[tag].add(listener);
  }

  off<K extends ChannelEventTag>(tag: K, listener: ChannelEventListener<K>): void {
    this.listeners[tag].delete(listener);
  }

  /**
   * Dispatch an event to every registered listener.
   *
   * Returns a Promise that resolves once every listener (sync or async) has
   * settled. Errors from individual listeners are aggregated into a thrown
   * `AggregateError` so one bad listener cannot mask another.
   */
  async emit<K extends ChannelEventTag>(
    tag: K,
    event: ChannelEventMap[K],
  ): Promise<void> {
    const listeners = this.listeners[tag];
    if (listeners.size === 0) return;
    const errors: unknown[] = [];
    await Promise.all(
      [...listeners].map(async (listener) => {
        try {
          await listener(event);
        } catch (err) {
          errors.push(err);
        }
      }),
    );
    if (errors.length > 0) {
      throw new AggregateError(errors, `channel event '${tag}' had ${errors.length} listener error(s)`);
    }
  }

  /** Test helper: drop every listener. */
  clear(): void {
    for (const set of Object.values(this.listeners)) {
      set.clear();
    }
  }
}
