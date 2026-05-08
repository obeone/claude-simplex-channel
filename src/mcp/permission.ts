/**
 * Permission relay request handler — v2 plan §8 step 7.
 *
 * Wires `setNotificationHandler` for `notifications/claude/channel/permission_request`
 * onto the MCP server. On hit:
 *   1. Synchronously register the request in `pendingPermReqs` (lowercased
 *      key, original-case requestId preserved for the eventual verdict echo).
 *   2. DM the bound owner via `apiSendTextMessage` with the verbatim
 *      verdict-instruction template from the plan.
 *
 * The DM step is awaited; if there is no bound owner yet, the request is
 * still registered so a later `bind owner <CODE>` followed by a verdict from
 * Claude is possible (the regex gate in PR 8a + tuple match in PR 8b protect
 * the verdict path). Operator visibility into the unbound case happens via
 * structured stderr logs.
 *
 * SINGLE-THREADED CONTRACT (echoed in pendingPermReqs.ts): this handler is
 * the only writer to `pendingPermReqs.set` for permission requests. Reads
 * happen from the inbound router (PR 8a), strictly synchronously between
 * regex match and verdict decision.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { ChatApi } from "simplex-chat/dist/api.js";
import { T } from "@simplex-chat/types";
import { z } from "zod";

import * as pendingPermReqs from "../channel/pendingPermReqs.js";
import { log } from "../util/log.js";

/** Method name per plan §6 / §8 step 7. */
export const PERMISSION_REQUEST_METHOD =
  "notifications/claude/channel/permission_request";

/**
 * Schema for the inbound `permission_request` notification.
 *
 * The MCP SDK's `setNotificationHandler` takes a zod schema with a `method`
 * literal so the dispatcher routes the right notifications here. `params`
 * carries the channel-specific payload.
 */
export const PermissionRequestSchema = z.object({
  method: z.literal(PERMISSION_REQUEST_METHOD),
  params: z.object({
    request_id: z.string().min(1),
    tool_name: z.string().min(1),
    description: z.string().default(""),
  }),
});

export type PermissionRequestNotification = z.infer<
  typeof PermissionRequestSchema
>;

/**
 * Dependencies for `installPermissionRequestHandler`.
 *
 * `getOwnerContactId` returns the bound owner's contactId or null when
 * unbound. Sync — the entrypoint binds it to `getOwnerSnapshot().ownerContactId`.
 */
export interface PermissionDeps {
  server: Server;
  api: Pick<ChatApi, "apiSendTextMessage">;
  getOwnerContactId: () => number | null;
}

/**
 * Build the verbatim DM body the plan §8 step 7 mandates.
 *
 * Wording is part of the operator contract — the owner reads this in the
 * SimpleX app. Drift here changes the verdict response shape downstream.
 */
export function buildOwnerDm(
  toolName: string,
  description: string,
  requestId: string,
): string {
  return (
    `Claude wants to run ${toolName}: ${description}\n\n` +
    `Reply "yes ${requestId}" or "no ${requestId}"`
  );
}

/**
 * Register the permission_request notification handler on the MCP server
 * and start the periodic TTL sweep on `pendingPermReqs`.
 *
 * Idempotent at the SDK level: `setNotificationHandler` replaces any prior
 * handler for the same method. `pendingPermReqs.startSweep()` is itself
 * idempotent.
 */
export function installPermissionRequestHandler(deps: PermissionDeps): void {
  deps.server.setNotificationHandler(
    PermissionRequestSchema,
    async (notification) => {
      const { request_id, tool_name, description } = notification.params;

      // (1) Register the pending request first. The router consults this
      // synchronously on every inbound DM; we want the entry visible BEFORE
      // we await the SimpleX DM round-trip so a fast owner-side reply (the
      // owner is fast and the SimpleX server is slow) can still find it.
      pendingPermReqs.set(request_id, tool_name, description);
      log.info({
        evt: "permission_request_registered",
        request_id,
        tool_name,
      });

      // (2) DM the owner. If unbound, log and bail — the entry stays in the
      // map so a later bind + verdict still works (within TTL).
      const ownerContactId = deps.getOwnerContactId();
      if (ownerContactId === null) {
        log.warn({
          evt: "permission_request_no_owner",
          request_id,
          tool_name,
        });
        return;
      }

      try {
        await deps.api.apiSendTextMessage(
          [T.ChatType.Direct, ownerContactId],
          buildOwnerDm(tool_name, description, request_id),
        );
        log.info({
          evt: "permission_request_dm_sent",
          request_id,
          contact_id: ownerContactId,
        });
      } catch (err) {
        log.error({
          evt: "permission_request_dm_failed",
          request_id,
          contact_id: ownerContactId,
          error: String(err),
        });
      }
    },
  );

  pendingPermReqs.startSweep();
}
