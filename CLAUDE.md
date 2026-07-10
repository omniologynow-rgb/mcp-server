# Omniology Repo Access — Agent Working Guidelines (v1)

## Repos in scope

- `@omniology/mcp-server` (npm STDIO package)
- `@omniology/eliza-plugin` (native ElizaOS plugin)

## Agent's ROLE

Ship user-facing polish + docs + release hygiene in the above two repos ONLY.

Focus areas: README quality, README badges, npm package metadata, examples/quickstarts, changelog, GitHub topics, social-preview images.

## Agent MAY

- ✓ Open PRs against feature branches (never push to main directly)
- ✓ Update README, CHANGELOG, examples, docs
- ✓ Add tests + verify existing test suite passes
- ✓ Bump package versions per semver
- ✓ Publish to npm ONLY after Matt approves the PR + reviews the release notes
- ✓ Ask questions via GitHub issues if unclear

## Agent MUST NOT

- ✗ Touch the engine repo (omniology/omniology-engine)
- ✗ Touch the website repo (Emergent-managed)
- ✗ Push to main directly on ANY repo
- ✗ Modify anything under a `.env*` file, Fly secrets, or GitHub Actions secrets
- ✗ Merge its own PRs (Matt merges after review)
- ✗ Change core behavior of MCP tools without design approval
- ✗ Modify the on-chain program interaction layer (register_agent message body, submit_entry signing flow, delegate references)
- ✗ Add or remove dependencies without a stated reason in the PR
- ✗ Publish npm packages without Matt's explicit "publish" approval per version

## Every PR must include (in the description)

1. **What changed** — 1-3 bullets
2. **Why** — user-visible benefit or bug fixed
3. **Files touched** — full paths list
4. **Test evidence** — one of: screenshot of local npm test passing / CI check green / manual test steps run
5. **Backwards compatibility** — any breaking change? if yes flag it
6. **Version bump** — patch/minor/major + reason
7. **Dependencies added/removed** — none by default; if yes, why
8. **Ready to publish?** — yes/no; if yes, waiting on Matt's go

## Coordination protocol

- Work only in the 2 repos listed above.
- If a change to the engine or website seems needed, write a GitHub issue in that repo and flag it in the handoff. Do NOT touch the other repo.
- Matt is the sole merge/publish/release approver.

## Safety escalation

On any of: errors undiagnosed in 15 min / test failures requiring >3 files to fix / anything touching key material, secrets, or network behavior / any dependency not already in package.json → STOP + hand back to Ryker with the error + a proposed path forward. No workarounds.
