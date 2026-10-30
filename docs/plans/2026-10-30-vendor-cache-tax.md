# Vendor cache-tax as a local plugin

Record state: COMPLETED

## Approved baseline

- Outcome: cache-tax ships from this repo as local plugin `plugins/cache-tax/` (`cache-tax@claude-optimization`), independent of the karanb192/cache-tax and karanb192/claude-code-mods GitHub repos.
- Scope and constraints: vendor v2.3.0 (upstream commit 432a08df1a22474a66b94240e2bcedaa6db55a17) runtime files, tests, LICENSE, README; leave out site/, docs/, tools/, .github/; switch settings.json and marketplace.json; update READMEs; no installer code changes.
- Acceptance criteria:
  1. `plugins/cache-tax/` holds runtime files, tests, LICENSE, README; no `claude-code-mods` in settings.json or README install instructions.
  2. `claude plugin validate plugins/cache-tax` and `claude plugin test plugins/cache-tax` pass.
  3. `./install.sh` installs `cache-tax@claude-optimization`; a second run reports everything up to date.
  4. `claude plugin list` shows `cache-tax@claude-optimization` enabled and no `cache-tax@claude-code-mods`.
- Approval evidence: user approved the plan in session on 2026-10-30 (saved plan `~/.claude/plans/i-need-to-make-unified-alpaca.md`); migration (T03) approved by user message "ok" the same day.
- Authorized actions and limits: edit repo files. The one-time migration on this machine (`./install.sh`, uninstalling `cache-tax@claude-code-mods`, removing the `claude-code-mods` marketplace) changes `~/.claude` and needs separate approval. Commit only on request.
- Record location: docs/plans/2026-10-30-vendor-cache-tax.md

## Tasks

| Task | Outcome; depends on | Progress | Gates | Next action |
| --- | --- | --- | --- | --- |
| T01 | Plugin files vendored into plugins/cache-tax/, tsconfig and plugin README adapted; none | ✅ DONE | G01 | None |
| T02 | marketplace.json, settings.json, repo README switched to local plugin; T01 | ✅ DONE | G02, G03 | None |
| T03 | Migration on this machine (needs approval); T02 | ✅ DONE | G04 | None |

## Gates

| Gate | Method and expected result | Status | Latest evidence |
| :-- | :-- | :-- | :-- |
| G01 | `claude plugin validate` and `claude plugin test` on plugins/cache-tax and plugins/session-usage; all pass | ✅ PASS | G01 attempt 1 |
| G02 | `python3 -I hooks/render-settings.py` renders; `grep -rn claude-code-mods` shows only provenance/migration notes | ✅ PASS | G02 attempt 1 |
| G03 | `bash hooks/test-bash-guard.sh` passes | ✅ PASS | G03 attempt 1 |
| G04 | `./install.sh` twice + cleanup; second run up to date; plugin list shows new id only | ✅ PASS | G04 attempt 1 |

## Evidence

All attempts ran in the repo root against uncommitted changes on top of a576100.

### G01 attempt 1

- `claude plugin validate plugins/cache-tax`: ✔ Validation passed (only catalog warning: no icon, same as upstream). `claude plugin validate plugins`: passed with an author warning for session-usage (pre-existing).
- `claude plugin test plugins/cache-tax`: 137 pass, 0 fail. `claude plugin test plugins/session-usage`: 2 pass, 0 fail.
- Status: PASS.

### G02 attempt 1

- `python3 -I hooks/render-settings.py . /x/bash-guard.sh /x/marketplace hosts/ai.json`: renders; enabledPlugins has `cache-tax@claude-optimization`, extraKnownMarketplaces has only `claude-optimization`.
- `grep -rn claude-code-mods` (excluding docs/plans): only README.md migration note. `plugins/cache-tax/README.md`: no `site/`, `docs/assets`, `tools/` or `claude-code-mods` references.
- Status: PASS.

### G03 attempt 1

- `bash hooks/test-bash-guard.sh`: pass=123 fail=0. Status: PASS.

### G04 attempt 1

- `./install.sh` (exit 0): copied cache-tax into ~/.claude/marketplace, installed `cache-tax@claude-optimization`, verified auto-mode config. Backups made of the changed marketplace.json and settings.json.
- `claude plugin uninstall cache-tax@claude-code-mods --scope user` and `claude plugin marketplace remove claude-code-mods`: both succeeded.
- `./install.sh` rerun (exit 0): only up-to-date/already-present lines; `.bak-*` count unchanged (5 before, 5 after).
- `claude plugin list`: `cache-tax@claude-optimization` 2.3.0, read from ~/.claude/marketplace/cache-tax, enabled. installed_plugins.json has no `cache-tax@claude-code-mods`; known_marketplaces.json is `claude-optimization`, `claude-plugins-official`.
- Status: PASS.

## Decisions and scope changes

- tsconfig.json uses the session-usage form (extends generated types); tests pass with it.
- Added an install line to the plugin README to clear the validator's README hint.
- Review follow-up (2026-10-30): plugin README "Local development" now uses `claude --plugin-dir plugins/cache-tax` from the repo root, matching the other sections. Revalidated (passed); `./install.sh` resynced the README and reinstalled the plugin (exit path reached "Verified").

## Handoff

- Outcome: cache-tax ships from plugins/cache-tax as `cache-tax@claude-optimization`; all four acceptance criteria met (G01–G04).
- Open gates and blockers: none.
- Limitations: cache-tax store is keyed by plugin id, so keepwarm window/score start fresh under the new id; old store file `~/.claude/plugins/store/cache-tax_claude-code-mods-*.json` left in place. Running sessions need `/reload-plugins` or a restart.
- Exact next action: none; commit when the user asks.
