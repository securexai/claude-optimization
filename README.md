# claude-optimization

Portable global configuration, Auto Mode policy, and `PreToolUse` safety hook for Claude Code (`~/.claude`), shared across machines with optional per-host overrides.

## Contents

| Path | Purpose |
| :--- | :--- |
| [`CLAUDE.md`](CLAUDE.md) | Global working agreements installed to `~/.claude/CLAUDE.md`. |
| [`skills/plan-execution/`](skills/plan-execution/SKILL.md) | Local `plan-execution` skill (referenced by [`CLAUDE.md`](CLAUDE.md)) installed to `~/.claude/skills/plan-execution/`. |
| [`settings.json`](settings.json) | Global Claude Code settings shared by every machine (`auto` mode, `modelSettings`, `hooks`, `enabledPlugins`), everything except `autoMode`. |
| [`automode/defaults.json`](automode/defaults.json) | Snapshot of `claude auto-mode defaults`; the built-in slot wording the rendered `environment` starts from. |
| [`automode/base.json`](automode/base.json) | `autoMode` policy shared by every machine: slot overrides about the user and the repositories, extra `environment` entries, and the `soft_deny` rules. |
| [`hosts/`](hosts/ai.json) | Optional per-host slot overrides, one `hosts/<short-hostname>.json` each. [`hosts/ai.json`](hosts/ai.json) describes the `ai` workstation (`Host containment`). |
| [`hooks/render-settings.py`](hooks/render-settings.py) | Renders the final `~/.claude/settings.json` from the files above and sets the hook path and the local marketplace path. Deterministic, and fails if a built-in slot it overrides is renamed, `{tail}` loses its marker, `automode/base.json` or a host file has an unknown key, or `soft_deny` doesn't start with `"$defaults"`. |
| [`hooks/bash-guard.sh`](hooks/bash-guard.sh) | `PreToolUse` guard hook for `Bash` and `Monitor`. Hard-denies Git hook bypasses (`--no-verify`, `commit -n`, `core.hooksPath`, `SKIP`/`HUSKY`/`LEFTHOOK`) and CLI/stdout secret leaks (`Authorization: Bearer $VAR`, uncaptured `podman secret inspect --showsecret`), and forces an interactive `ask` prompt on `git push` and mutating `gh` commands. |
| [`hooks/test-bash-guard.sh`](hooks/test-bash-guard.sh) | 123-case regression test suite for [`hooks/bash-guard.sh`](hooks/bash-guard.sh). |
| [`install.sh`](install.sh) | Idempotent installer: checks dependencies and the `automode/defaults.json` snapshot, self-tests the hook and renders `settings.json` before installing anything, then installs the hook, `CLAUDE.md`, skills, the `plugins/` marketplace and `settings.json`, the configured marketplaces and plugins (reinstalling a pinned plugin whose commit changed), and verifies every `claude auto-mode config` list (`soft_deny` must be the built-in rules plus the custom ones). |
| [`plugins/.claude-plugin/marketplace.json`](plugins/.claude-plugin/marketplace.json) | Local marketplace `claude-optimization`, installed to `~/.claude/marketplace/`: third-party plugins as `git-subdir` sources, each pinned to a reviewed commit `sha`. |
| [`docs/plans/`](docs/plans/) | Execution records of approved changes (history, not current guidance). |

## Replicating on a Fresh Machine

Prerequisites: `claude` CLI, `git` (used by `claude plugin marketplace add`), `jq`, `python3`, `cmp` (diffutils), and GNU `grep` with `-P`. Desktop Fedora ships `python3`, `cmp` and GNU `grep`; install `claude` and, if missing, `jq` (on Kinoite/Silverblue with `rpm-ostree install jq`, or run the installer from a toolbox, which shares your `$HOME`; there it uses the host's name, not `toolbx`). Minimal images such as the `fedora` container also lack `cmp`; install `diffutils`.

```bash
git clone git@github.com:securexai/claude-optimization.git
cd claude-optimization
./install.sh            # host = short hostname, lowercased; or ./install.sh --host NAME
```

- `~/.claude` means `$CLAUDE_CONFIG_DIR` when that is set.
- Nothing is installed until the dependency check, the defaults snapshot check, the hook self-test and rendering pass; a failure there exits before any file is installed or backed up.
- If `hosts/<host>.json` exists, its overrides are applied; otherwise the installer warns and installs the shared base, with the built-in wording for host slots.
- If `claude` isn't logged in, the installer installs the files, then stops with exit code 3 before plugins and verification. Run `claude auth login` and rerun `./install.sh` to finish.
- Reruns are idempotent: when `~/.claude` already matches, every step reports `Up to date` or `already present` and no backups are made. Changed files are backed up to `*.bak-<timestamp>` before being replaced; a file with the right content but another mode only gets its mode fixed.
- If a configured marketplace is already known from a different repository or path, the installer stops: remove it with `claude plugin marketplace remove NAME` and rerun.
- `enabledPlugins` ids ending in `@builtin` (such as `cc-plugin-you-should-know@builtin`, the You Should Know side agent) ship with `claude`; the installer doesn't run `claude plugin install` for them, because the `settings.json` entry is what turns them on. The CLI doesn't validate built-in ids, so check the spelling. You Should Know runs only in first-party sessions with telemetry on.
- Plugins from the `claude-optimization` marketplace run at the commit pinned in [`plugins/.claude-plugin/marketplace.json`](plugins/.claude-plugin/marketplace.json). It holds Blast Radius and Replay Theater, two mods from [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods), which is an unsupported playground. To move a pin, review the plugin's code at the new commit, change its `sha`, and rerun `./install.sh`. `claude plugin update` only compares `plugin.json` versions, so the installer uninstalls (keeping plugin data) and reinstalls any plugin whose installed commit differs from its pin. To add a plugin, add its entry there and enable `NAME@claude-optimization` in `settings.json`.
- Blast Radius holds `rm -r`/`-f`, `git reset --hard`, `git clean`, `git checkout -- .`, force pushes and migrations until you press Proceed (`1`) or Cancel (`2`). It refuses after 10 minutes without an answer, so in headless runs (`claude -p`) those commands are refused. Below about 144 columns it draws in the band above the prompt, which Replay Theater also uses after every turn that edits files, so its buttons may not show there. Use a wide terminal when you rely on it.
- The repository is the source of truth: `~/.claude/settings.json` is overwritten on each run that renders something different, so make lasting changes (including ones made with `/config`) here.

## Adding a Host

Create `hosts/<short-hostname>.json` with only the slots that describe that machine:

```json
{
  "environment": {
    "Host containment": "Claude Code runs directly on the user's laptop (hostname NAME) ... {tail}"
  }
}
```

A host entry replaces the base override for the same slot (it doesn't append). A host file may only contain `environment`. Override text may use `{default}` (the built-in slot text without its trailing period) and `{tail}` (the built-in rules after "Whatever is configured", which `Host containment` should keep; rendering fails if that phrase is gone). Other braces are literal. Keep entries that only add caution (deny rules, sensitive targets) in `automode/base.json`, so every machine gets them.

## Updating `autoMode` Rules After a Claude Code Upgrade

`autoMode.environment` replaces the built-in environment slots (without `"$defaults"`, which would conflict on the `Source control` slot), so `./install.sh` stops before installing anything when `claude auto-mode defaults` no longer matches the snapshot. Refresh it:

```bash
claude auto-mode defaults > automode/defaults.json
git diff automode/defaults.json   # review the changed built-in wording
./install.sh
```

If the renderer reports `default slots not found`, a slot it overrides was renamed: update the label in `automode/base.json` or `hosts/*.json`.
