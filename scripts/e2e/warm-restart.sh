#!/usr/bin/env sh
# scripts/e2e/warm-restart.sh
#
# End-to-end harness for `warm_restart_resubscribes_within_Ns`
# (v2 plan §8 step 10, threshold N=30s placeholder).
#
# Measures SimpleX SMP/XFTP resub latency after a clean restart of the
# channel process. The DB warm-restarts from SQLCipher; only the in-memory
# `pendingPermReqs` is intentionally lost (covered by addon_crash_restart).
#
# Operator pre-conditions (gated by SIMPLEX_E2E_HARNESS=1):
#   - Channel built and previously paired.
#   - SIMPLEX_E2E_OWNER_CONTACT_ID + SIMPLEX_E2E_OWNER_PEER_BIN as in
#     scripts/e2e/addon-crash-restart.sh.
#   - SIMPLEX_E2E_RESUB_PROBE_INTERVAL_MS (default 250) — how often the
#     harness pings the owner peer to detect the SMP queue is back.
#
# Final stderr line MUST be one of:
#   WARM_RESTART: PASS resub_latency_ms=<int> threshold_ms=30000
#   WARM_RESTART: FAIL reason=<short> resub_latency_ms=<int|na>
#
# Like the crash-restart harness, the actual SMP probing loop is operator-
# specific (it needs a second peer that can DM the channel and observe the
# round-trip latency). The script below is a typed skeleton; the operator
# fills in the probe.
set -eu

if [ "${SIMPLEX_E2E_HARNESS:-0}" != "1" ]; then
    printf 'WARM_RESTART: FAIL reason=harness_not_enabled resub_latency_ms=na\n' >&2
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
    printf 'WARM_RESTART: FAIL reason=missing_env=%s resub_latency_ms=na\n' "$missing" >&2
    exit 3
fi

# Operator-side TODO (same shape as the addon-crash harness):
#   1. Start ./bin/claude-simplex-channel and wait for SIMPLEX ADDRESS banner.
#   2. From the owner peer, DM the channel and time-stamp the round-trip
#      (call it RT_baseline_ms).
#   3. SIGTERM the channel (clean exit), then immediately respawn it.
#   4. Poll: every $SIMPLEX_E2E_RESUB_PROBE_INTERVAL_MS, DM the channel
#      from the owner peer; record the timestamp the DM arrives at the
#      channel (visible via the inbound subscriber's structured log).
#   5. resub_latency_ms = arrival_ts - respawn_ts. Emit:
#        WARM_RESTART: PASS resub_latency_ms=<measured> threshold_ms=30000
#      iff measured <= 30000, else:
#        WARM_RESTART: FAIL reason=resub_too_slow resub_latency_ms=<measured>

printf 'WARM_RESTART: FAIL reason=operator_harness_not_implemented resub_latency_ms=na\n' >&2
exit 4
