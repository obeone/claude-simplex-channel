#!/usr/bin/env sh
# scripts/e2e/addon-crash-restart.sh
#
# End-to-end harness for `addon_crash_restart_reopens_verdict_window`
# (v2 plan §8 step 10).
#
# Operator pre-conditions (the test only runs when SIMPLEX_E2E_HARNESS=1):
#   - The MCP channel is built (`npm run build`).
#   - An owner is already paired in the project's SQLite DB (worker-state's
#     PR 5 pairing flow has run end-to-end at least once).
#   - SIMPLEX_E2E_OWNER_CONTACT_ID is exported with the bound owner's
#     contactId so this script can target it from the second SimpleX peer
#     used as the "owner DM endpoint".
#   - SIMPLEX_E2E_OWNER_PEER_BIN points at a second SimpleX bot binary the
#     operator drives (e.g. a second `simplex-chat` CLI logged into the
#     owner's profile) so we can read the DM and emit `yes <id>` back.
#
# Final stderr line MUST be one of:
#   ADDON_CRASH_RESTART: PASS request_id_post=bbbbb verdict_emitted=true
#   ADDON_CRASH_RESTART: FAIL reason=<short-string>
#
# This script is intentionally a skeleton: the live SimpleX bring-up + the
# verdict-bytes capture path requires per-operator credentials and is left
# for the operator to fill in below. The skipIf gate in the vitest file
# means CI never reaches this script — only operators who explicitly
# opt-in via SIMPLEX_E2E_HARNESS=1 do.
set -eu

if [ "${SIMPLEX_E2E_HARNESS:-0}" != "1" ]; then
    printf 'ADDON_CRASH_RESTART: FAIL reason=harness_not_enabled\n' >&2
    exit 2
fi

missing=""
for var in SIMPLEX_E2E_OWNER_CONTACT_ID SIMPLEX_E2E_OWNER_PEER_BIN; do
    eval "value=\${$var:-}"
    if [ -z "$value" ]; then
        missing="${missing}${missing:+, }${var}"
    fi
done

if [ -n "$missing" ]; then
    printf 'ADDON_CRASH_RESTART: FAIL reason=missing_env=%s\n' "$missing" >&2
    exit 3
fi

# The actual respawn + permission-request injection + verdict capture loop
# lives here. It is left as TODO for the operator: every site is
# operator-environment-specific (owner peer's chat-id, transport for the
# fake permission_request injection, etc.) and faking it would defeat the
# purpose of the test. See docs/plans/v2-claude-simplex-channel.md §8
# step 10 for the exact dance:
#
#   1. Spawn ./bin/claude-simplex-channel under a respawn loop.
#   2. Inject permission_request id=aaaaa via the MCP stdio.
#   3. Verify the owner peer received "yes aaaaa" instructions.
#   4. SIGSEGV the channel (kill -SIGSEGV $pid).
#   5. Wait <=5s for the respawn-loop to bring it back up (`pgrep` the bin).
#   6. Inject permission_request id=bbbbb.
#   7. Verify owner peer received "yes bbbbb".
#   8. From the owner peer, DM "yes bbbbb" to the channel.
#   9. Capture the MCP verdict notification on fd 3 (the wrapper preserves
#      it; you can `tee` fd 3 in a copy of bin/claude-simplex-channel for
#      the duration of the test).
#  10. Assert the verdict's request_id == "bbbbb" and behavior == "allow".
#
# Until the operator fills this in:
printf 'ADDON_CRASH_RESTART: FAIL reason=operator_harness_not_implemented\n' >&2
exit 4
