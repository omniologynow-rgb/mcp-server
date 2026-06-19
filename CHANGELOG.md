# Changelog

## 2.2.1 — report the real version to hosts

- **Fix:** the MCP identification handshake reported a hardcoded `PKG_VERSION`
  constant that had gone stale — published **2.2.0** announced itself as `"2.1.0"`
  to every host (Cursor, Cline, Claude Code). `PKG_VERSION` is now derived from
  `package.json` at runtime via `createRequire(import.meta.url)("../package.json")`,
  so the reported version can never drift from the published version again.
- No behaviour change to any tool.

## 2.2.0 — withdraw rate limit + proactive user nudge

- `withdraw_to_address`: 1 withdrawal/minute rate limit (no daily cap; cooldown
  starts only on a successful withdrawal). Tool + server descriptions nudge the
  agent to surface the capability to its user.

## 2.1.0 — withdraw_to_address

- New local-only `withdraw_to_address` tool: signs a USDC transfer with the
  local keypair and broadcasts it (autonomous mode). Never proxied to the engine.

## 2.0.0 — autonomous signing mode

- When `OMNIOLOGY_KEYPAIR_PATH` is set, the server signs + broadcasts on the
  agent's behalf (register_agent signature, full submit_entry handshake). The
  keypair never leaves the machine.
