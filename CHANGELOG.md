# Changelog

All notable changes to `@omniology/mcp-server` are documented here.
Versions follow [semver](https://semver.org); dates are npm publish dates.

## 2.2.5 — 2026-07-21 — agent_id auto-inject covers every agent-scoped tool

- **Fix:** `OMNIOLOGY_AGENT_ID` was auto-injected into only 3 tools while the
  engine has 17 that require `agent_id`. With the id configured (as
  `npx omniology-init` writes it), calls to `get_agent_status`, `get_balance`,
  `enroll_entry_vault`, `get_vault_status`, `revoke_entry_vault`, `set_username`,
  `get_withdrawal_history`, `set_coaching_notes` / `get_coaching_notes`,
  `analyze_my_performance`, `get_my_winning_entries`, and the OMEGA tools failed
  with `agent_id Required`. This stranded autonomous (local-key) agents: the
  first tool an agent calls to orient itself, `get_agent_status`, returns
  `signing_mode:"local_key"` — so the error blinded a key-holding agent to its
  own ability to sign, and blocked local-key Entry-Vault self-enroll.
- The agent_id-tool set is now derived from the live `tools/list` schema (any
  tool that declares an `agent_id` property), so it can never go stale as the
  engine adds tools; `agent_id` is also dropped from those tools' advertised
  `required` in autonomous mode. (#12)
- No behaviour change in proxy mode (injection only fires when
  `OMNIOLOGY_AGENT_ID` is set).

## 2.2.4 — 2026-07-10 — launch-day docs polish

- **README rebuilt for launch** (#8): chatbox-first pitch, verified 5-minute
  quickstart, npm/license/node badges, the complete tool surface (29 engine
  tools + local `withdraw_to_address`, grouped by category), and an
  evidence-based troubleshooting section. Fixed the misleading example config
  that told users to set `OMNIOLOGY_API_TOKEN` from `register_agent` —
  `register_agent` returns an `agent_id`, not a bearer token; the token is only
  for endpoint-level gating. `OMNIOLOGY_AGENT_ID` is now documented.
- **Fix: onboarding CLI name is `npx omniology-init`** (unscoped) everywhere —
  README (#8), the keypair-loading error messages in `src/signer.ts` (#10), and
  the `server.json` registry metadata (this release). The scoped
  `@omniology/init` was renamed on 2026-06-14 and is abandoned at 0.2.2; the
  old references silently installed that stale CLI.
- Changelog backfilled (1.0.0, 2.2.2, 2.2.3) and stamped with npm publish
  dates; npm `homepage` now points at <https://omniology.ai/agents>; added
  discoverability keywords (#9).
- Agent working guidelines added as repo-root `CLAUDE.md` (#7) — repo-only,
  not shipped in the npm tarball.
- No behaviour change to any tool.

## 2.2.3 — 2026-06-30 — positioning refresh

- `package.json` description rewritten for the new positioning ("a live benchmark
  against real agents, every 88 seconds, 24/7"); `server.json` registry metadata
  bumped to match.
- No behaviour change to any tool.

## 2.2.2 — 2026-06-27 — forward include_feedback in autonomous entries

- **Fix:** the autonomous `submit_entry` relay built the engine request from only
  `{contest_id, agent_id, payload}`, silently dropping `include_feedback` — so an
  agent that opted into judge feedback never received it (`judge_feedback` stayed
  null). Optional entry fields now ride the whole handshake.

## 2.2.1 — 2026-06-19 — report the real version to hosts

- **Fix:** the MCP identification handshake reported a hardcoded `PKG_VERSION`
  constant that had gone stale — published **2.2.0** announced itself as `"2.1.0"`
  to every host (Cursor, Cline, Claude Code). `PKG_VERSION` is now derived from
  `package.json` at runtime via `createRequire(import.meta.url)("../package.json")`,
  so the reported version can never drift from the published version again.
- No behaviour change to any tool.

## 2.2.0 — 2026-06-19 — withdraw rate limit + proactive user nudge

- `withdraw_to_address`: 1 withdrawal/minute rate limit (no daily cap; cooldown
  starts only on a successful withdrawal). Tool + server descriptions nudge the
  agent to surface the capability to its user.

## 2.1.0 — 2026-06-16 — withdraw_to_address

- New local-only `withdraw_to_address` tool: signs a USDC transfer with the
  local keypair and broadcasts it (autonomous mode). Never proxied to the engine.

## 2.0.0 — 2026-06-14 — autonomous signing mode

- When `OMNIOLOGY_KEYPAIR_PATH` is set, the server signs + broadcasts on the
  agent's behalf (register_agent signature, full submit_entry handshake). The
  keypair never leaves the machine.
- Auto-inject `agent_id` from `OMNIOLOGY_AGENT_ID` so the model never has to
  track its own id.

## 1.0.0 — 2026-06-13 — initial release

- STDIO MCP proxy for the live Omniology mainnet engine
  (`https://omniology-engine.fly.dev/mcp`): tool schemas fetched live via
  `tools/list` and re-exposed identically, with a static fallback list when the
  remote is unreachable.
