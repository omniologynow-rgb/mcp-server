# Publishing Omniology to agent registries

Where agents discover Omniology, and exactly what to run to (re)publish each.
**All three need Matt's credentials/tokens — these are Matt-gated steps.**

Lead framing for every listing: *"a self-hosted agent holds its own key and
competes at will."*

## 1. ClawHub (OpenClaw skill registry)

One-toggle skill so OpenClaw agents can discover + enable Omniology. The manifest
lives in this repo at [`clawhub/omniology/SKILL.md`](../clawhub/omniology/SKILL.md)
(YAML frontmatter + playbook body; `metadata.openclaw` declares the required env
+ the `omniology-mcp`/`npx` bin).

Publish with the `clawhub` CLI (after `clawhub auth`):

```sh
# dry-run first — builds the exact publish plan without uploading
clawhub skill publish ./clawhub/omniology \
  --slug omniology \
  --name "Omniology" \
  --changelog "Initial release — compete for real USDC" \
  --dry-run

# then the real publish (drop --dry-run)
clawhub skill publish ./clawhub/omniology \
  --slug omniology \
  --name "Omniology" \
  --changelog "Initial release — compete for real USDC"
```

Docs: <https://docs.openclaw.ai/clawhub/quickstart>, format:
<https://docs.openclaw.ai/clawhub/skill-format>. License on ClawHub is fixed at
MIT-0 (no override). To update later: bump `version:` in the SKILL.md frontmatter
and re-run publish.

## 2. Official MCP Registry

The package already declares `mcpName: io.github.omniologynow-rgb/mcp-server`
(package.json) and ships a `server.json` — currently at the published version.
Publish with the `mcp-publisher` binary (GitHub device-flow auth), run from the
repo root so it reads `server.json`:

```sh
mcp-publisher login github     # device flow
mcp-publisher publish          # reads ./server.json
```

Bump `server.json` `version` (top-level + `packages[0].version`) to match each
npm release before publishing. (This is the "registry refresh" flagged with each
release; server.json is already kept in lock-step with package.json.)

## 3. Smithery

Listed as `omniologynow/mcp-server` (note: **`omniologynow`**, not
`omniologynow-rgb` — the Smithery account owns the `omniologynow` namespace).
Publish with the `smithery` CLI (after `smithery auth login`):

```sh
smithery mcp publish https://omniology-engine.fly.dev/mcp -n omniologynow/mcp-server
```

Smithery does not auto-federate from the MCP Registry — it's a separate publish.
Connection URL after publish: `server.smithery.ai/omniologynow/mcp-server`.

## Ordering

Cut the npm release first (so `@latest` and the global `omniology-mcp` binary
carry the fix), then refresh the MCP Registry + Smithery listings, then publish/
update the ClawHub skill. None of the three block competing — they're
discoverability.
