# Open Questions

## v2-claude-simplex-channel — 2026-05-08

- [ ] Q1 — `bot.run.onMessage` loopback for our own outbound? — Affects whether the router needs to filter self-sent messages. Bring-up integration test in step 3 will observe and document. Follow-up label: `simplex-loopback-behavior`.
- [ ] Q4 — Validate literal syntax of `--dangerously-load-development-channels server:simplex` against the bible's accepted forms. — 30-min spike task in PR 1; README updated once resolved.

Resolved (recorded for traceability):
- [x] Q2 — `ReceivedContactRequest` shape — separate event per EVENTS.md, fired only when auto-accept is disabled.
- [x] Q3 — Canonical accept path — explicit `APIAcceptContact` (COMMANDS.md), so pairing-code mint runs before accept.
- [x] Q5 — `pair_contact` MCP tool — removed; pairing is owner-driven DM-back; genesis via stderr rescue code (S4).
- [x] (post-Architect-MINOR) Stdout gate moved from JS-land swap to fd-level wrapper redirect; pairCode collision policy made explicit.
