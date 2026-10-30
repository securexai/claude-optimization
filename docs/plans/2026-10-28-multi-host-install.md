# Multi-host idempotent install

Record state: ACTIVE

## Approved baseline

- Outcome: on any machine, `git clone` + `./install.sh` yields `~/.claude/settings.json` built from a shared base plus that host's file (if any); a second run changes nothing and creates no new `.bak` files.
- Scope and constraints:
  - Split autoMode policy into data: `automode/defaults.json` (snapshot of `claude auto-mode defaults`), `automode/base.json` (base overrides, extra environment, soft_deny), `hosts/ai.json` (workstation overrides: Host containment, workstation half of Sensitive data locations). `settings.json` keeps everything except `autoMode`.
  - Base = caution-adding entries and user/repo identity; host = entries describing this workstation. Unlisted host falls back to built-in default wording for host slots.
  - `make-proposal.py` becomes `render-settings.py` (defaults + base + host → settings), deterministic, keeps the "slot wording changed" failure. Python 3 becomes a prerequisite.
  - `install.sh`: host from `hostname -s` or `--host NAME`; missing host file → warn, base only. Keep the user's `skills/` step. Stop with "log in, then rerun" before plugins/verify if `claude` is not logged in. Final verify also compares `soft_deny`.
  - README: layout, adding a host, login order, refreshing defaults after upgrade, repo is source of truth.
- Acceptance criteria:
  1. `render-settings.py --host ai` output is identical to the current live `~/.claude/settings.json` (modulo hook path rewrite, which is the same on this machine).
  2. Rendering for an unknown host gives built-in default wording for host slots and keeps base entries.
  3. In a clean rootless podman Fedora container (empty HOME): install, rerun → rerun prints only up-to-date/already-present and no new `.bak`; logged-out run stops with the login message; unknown hostname installs base only.
  4. bash-guard self-tests pass; README updated.
- Approval evidence: user message "approve" on 2026-10-28 replying to the 8-step plan in this session.
- Authorized actions and limits: edit/create repo files; create and delete my own throwaway podman container; download claude/plugins and log in inside the container. Commit, `gh repo create` (private securexai/claude-optimization) and push each need separate approval (step 8). Don't touch the staged `AD` index entries (prompt-audit, proposed/) or `skills/` contents.
- Record location: docs/plans/2026-10-28-multi-host-install.md

## Tasks

| Task | Outcome; depends on | Progress | Gates | Next action |
| --- | --- | --- | --- | --- |
| T01 | Data files + `render-settings.py`; none | ✅ DONE | G01, G02 | — |
| T02 | `install.sh` host selection, login stop, soft_deny verify; T01 | ✅ DONE | G03, G04 | — |
| T03 | Clean-container test; T02 | ✅ DONE | G05 | — |
| T04 | README; T02 | ✅ DONE | G06 | — |
| T05 | Commit, create repo, push; T03, T04, T06–T10, user approval | 🚧 BLOCKED | G07 | Await user approval of commit, repo creation, push |
| T06 | Review fix 4: strict `render-settings.py` (literal braces, `{tail}` marker check, unknown keys, utf-8, usage); none | ✅ DONE | G08 | — |
| T07 | Review fix 5: all sensitive locations in base.json, slot removed from hosts/ai.json; T06 | ✅ DONE | G09 | — |
| T08 | Review fixes 1–3, 6, 7: install.sh checks-before-changes order, install helper, verification, hostname, CLAUDE_CONFIG_DIR, plugin checks; T06 | ✅ DONE | G10, G11, G12, G13 | — |
| T09 | Docs: README and install.sh comments match the new behaviour; T07, T08 | ✅ DONE | G14 | — |
| T10 | Commit prep: `git rm --cached` the four staged `AD` entries; none | ✅ DONE | G15 | — |

## Gates

| Gate | Method and expected result | Status | Latest evidence |
| :-- | :-- | :-- | :-- |
| G01 | Render `--host ai`; `cmp` with live `~/.claude/settings.json` → identical | 🔁 STALE | attempt 1; superseded by G09 (review fix 5 changes policy text) |
| G02 | Render unknown host; host slots equal defaults.json wording, base slots present, soft_deny unchanged | 🔁 STALE | attempt 2; re-proven in G08 |
| G03 | `./install.sh` on this machine twice → all "Up to date"/"already present", no new `.bak`, verify passes | 🔁 STALE | attempt 3; install.sh changed, live rerun needs approval |
| G04 | `bash -n install.sh`, shellcheck if available, bash-guard tests pass (inside installer) | 🔁 STALE | attempt 1; re-proven in G10 |
| G05 | Clean container: logged-out stop, install, rerun idempotent, unknown host base-only | 🔁 STALE | attempts 2–3; install.sh changed, covered by G11 in a throwaway HOME, container not rerun |
| G06 | README commands match install.sh flags/paths; links resolve | 🔁 STALE | attempt 1; re-proven in G14 |
| G07 | Remote shows pushed commit, repo private | 🚧 BLOCKED | needs approval for commit, `gh repo create`, push |
| G08 | Renderer: `{{.X}}`, `${HOME}`, `{}` render literally; `{tail}` without marker, unknown base/host keys exit non-zero; base-only render keeps G02 properties | ✅ PASS | attempt 2 |
| G09 | New `--host ai` render vs live `~/.claude/settings.json`: only the Sensitive data slot differs; base-only render contains all sensitive locations; no slot text duplicated across base and host | ✅ PASS | attempt 1 |
| G10 | `bash -n` and `shellcheck` clean on install.sh; 123/123 guard tests | ✅ PASS | attempt 1 |
| G11 | Throwaway HOME (stubbed login, real `claude auto-mode`): base-only and `--host ai` install then rerun → rerun quiet, no new `.bak`, Verified; mode-only drift is repaired; `CLAUDE_CONFIG_DIR` honoured | ✅ PASS | attempt 2 |
| G12 | Negatives, each exits non-zero with ~/.claude untouched where it runs before installs: broken hook, missing dependency, stale defaults snapshot, jq failure in plugin list, soft_deny without `$defaults`, bad `--host`, repo mismatch for an existing marketplace | ✅ PASS | attempt 1 |
| G13 | Inside toolbox `dev-toolbox`: installer picks `hosts/ai.json`; uppercase `--host AI` → ai | ✅ PASS | attempt 1 |
| G14 | README commands, flags, prerequisites and placeholder rules match install.sh and render-settings.py; links resolve | ✅ PASS | attempt 1 |
| G15 | `git status` shows no `AD` entries; `git ls-files` lacks the four paths; blob ids recorded for restore | ✅ PASS | attempt 1 |

## Evidence

### G01 attempt 1
- `python3 -I hooks/render-settings.py . $HOME/.claude/hooks/bash-guard.sh hosts/ai.json | cmp - ~/.claude/settings.json` in repo root → identical. PASS. Inputs: automode/defaults.json (claude 2.1.312), base.json, hosts/ai.json, settings.json without autoMode.

### G02 attempt 1
- Assertion script failed: `llama_api_key` check covered soft_deny, where base's Container Removal rule names it by design. Test bug; check narrowed to environment. FAIL (test).

### G02 attempt 2
- Render with no host file; asserted Host containment == defaults wording, no workstation strings in environment, base slots and soft_deny and non-autoMode settings equal to the ai render, same slot set. PASS.

### G03 attempt 1
- `./install.sh` twice on host ai (repo root), `.bak-*` list under ~/.claude before/after identical; both rc=0; run 2 output all "Up to date"/"already present", 123/123 guard tests, "Verified" line. PASS.

### G05 attempt 1 (container co-fresh-test, fedora:44, HOME=/root, claude 2.1.312, logged out)
- FAIL: `cmp` (diffutils) absent in minimal image; `! cmp` treated "command not found" as "differs", so every rerun backed up and reinstalled every file. Also no `hostname` command. Fix: host from `uname -n` (domain stripped); `cmp` added to prerequisite check.

### G05 attempt 2 (same container, fresh ~/.claude files, repo copied with tar excluding .git)
- No cmp → exit 1 "required command 'cmp' not found", nothing installed. After `dnf install diffutils`: run 1 installs all files, warns no hosts/fresh-test.json, exits 3 with login message; run 2 exit 3, no Installed/Backed up lines, `.bak` list unchanged. `--host ai` run: one settings backup (expected, content changes), next run quiet. Logged-out phase PASS; logged-in phase not run.

### G05 attempt 3 (co-fresh-test, user logged in)
- Default host (fresh-test): rc 0, base-only warning, settings replaced once (container had the ai render), 3 marketplaces added, 3 plugins installed, Verified. Rerun: rc 0, nothing installed/backed up/added, `.bak` list unchanged, Verified.
- `--host ai`: rc 0, settings replaced once, Verified. Rerun: rc 0, quiet, `.bak` list unchanged, Verified. PASS.
- Afterwards: `claude auth logout` in container, container and fedora:44 image removed.

### G03 attempt 2
- After cmp/uname changes: `./install.sh` twice on ai, rc 0/0, no Installed/Backed up lines, `.bak` list unchanged, Verified line. PASS. Then `--help` sed range changed (2,3p → 2,4p; not on the install path) → STALE.

### G03 attempt 3
- Final install.sh (sha256 bcbe295a…): two runs on ai, rc 0/0, nothing installed or backed up, `.bak` list unchanged, Verified line. PASS.

### G04 attempt 1
- `bash -n install.sh` OK; in container `shellcheck install.sh hooks/bash-guard.sh` clean (rechecked after final edit); test-bash-guard.sh only SC2016 info (intentional literal test strings), clean at `-S warning`; 123/123 guard tests in every run. PASS.

### G06 attempt 1
- Every README relative link exists; `./install.sh -h` prints the usage line; flags/paths in README match install.sh. PASS.

### G08 attempt 1
- Repo copy in scratchpad, render-settings.py sha256 prefix after edit (see G10 inputs). Base-only and `--host ai` output byte-identical to the pre-change render. Host override with `${HOME} {} repos/{owner}/{repo} {{.SecretData}} {tail}` renders those literally and expands `{tail}`. defaults.json with the marker reworded: `--host ai` exits 1 naming the slot; base-only (no `{tail}`) exits 0. Unknown keys exit 1: host `environmnet`, host `soft_deny`, `hosts/../settings.json`, base `extra`. Usage string shows `hooks/render-settings.py`. Base-only Host containment equals defaults wording and has no ai strings (G02 property). PASS.

### G09 attempt 1
- Repo root. New `--host ai` render vs live `~/.claude/settings.json`: differing scalar paths are `autoMode.environment[18]` (Sensitive data: only the lead phrase changes, "on this machine" → "wherever they exist") and `modelSettings.claude-opus-5-5.effortLevel` (live `xhigh`, repo `medium`: from the user's `/effort` in this session, not this change; left as is). Base-only render contains all six sensitive locations. No slot is overridden in both base.json and hosts/ai.json; base-only and ai renders differ only in Host containment. First comparison attempt was a broken jq test (`paths` on null input) and is not counted. PASS.

### G10 attempt 1
- Repo root, final install.sh (sha256 a9b7a8c30dc4…). `bash -n` OK; `shellcheck install.sh hooks/bash-guard.sh` clean and `shellcheck -S warning hooks/test-bash-guard.sh` clean (toolbox dev-toolbox, rerun after each install.sh edit); `rm -f` with no operands and an empty array under `set -u` verified; `--help` rc 0; repo guard tests pass=123 fail=0. PASS.

### G11 attempt 1
- Throwaway HOME, claude stub (scratchpad/bin/claude: fakes `auth status` when STUB_LOGIN=1, records plugin effects; real claude 2.1.312 for `auto-mode defaults/config`). PASS on the then-current install.sh, which was then changed (soft_deny expansion, list reads moved to step 3) → STALE.

### G11 attempt 2 (final install.sh a9b7a8c30dc4…, render-settings.py ecdbb1bb72d9…, base.json d731db66ef9e…, hosts/ai.json 1c249bcfc0bf…)
- `--host fresh-test` logged out: rc 3, 6 files installed, base-only warning (also proves `claude auto-mode defaults` works logged out). Logged in: rc 0, 3 marketplaces + 3 plugins via stub, Verified. Rerun: rc 0, 0 change lines, 0 `.bak`. `--host ai`: rc 0, settings backed up once; rerun (default host = ai) quiet. `chmod 600 CLAUDE.md` → "Set mode 0644", no backup; next run quiet. `CLAUDE_CONFIG_DIR=$G/cfg`: 12 changes into cfg only (HOME/.claude has no managed files), hook command points into cfg, rerun quiet, Verified (control without the variable sees 72 soft_deny rules, so the pass proves claude read cfg). Earlier attempt 1 also showed skills identical to the repo and settings == ai render. PASS.

### G12 attempt 1 (scratchpad/g12.sh; each case a fresh HOME, repo copies for mutated inputs; final install.sh)
- First run found that a non-GitHub marketplace failed only after 6 files were installed; list reads moved to step 3 and the suite rerun. Final run:
- Broken hook (`exit 0` injected) over a working install: rc 1, 121 FAIL lines, live hook sha unchanged, no `.bak`. No git in PATH: rc 1, "required command 'git'", nothing installed. Stale defaults snapshot: rc 1, refresh message, nothing installed. Non-GitHub marketplace: rc 5, jq error naming it, nothing installed; no `extraKnownMarketplaces`: rc 0, no marketplace lines. base.json without `$defaults`: rc 1 from the renderer, nothing installed. Effective soft_deny without built-ins (stubbed config): rc 1 "in: soft_deny"; extra environment entry + missing allow rule: rc 1 "in: allow, environment". `--host` `../settings`, empty, `a b`, `-x`, `ai/../x`: rc 2, nothing installed. Known marketplace from another repo: rc 1 with remove hint; marketplace added under another name: rc 1 with key hint. No `/tmp/tmp.*` left. PASS.

### G13 attempt 1
- `toolbox run -c dev-toolbox` (uname -n `toolbx`), throwaway HOME, no `--host`: "Host overrides: hosts/ai.json", rc 3 (logged out). On the host: `--host AI` → hosts/ai.json; uname stub `AI.example.lan` → hosts/ai.json. PASS.

### G08 attempt 2 (after adding the `$defaults` check)
- Final renderer output byte-identical to the G09 renders (base-only and ai); vs the pre-change base-only render only autoMode.environment differs (T07). Literal braces, `{tail}` marker, unknown host/base keys, Host containment wording rechecked; soft_deny starts with `$defaults`. PASS.

### G14 attempt 1
- Repo root. Relative links in README.md, skills/plan-execution/SKILL.md and this record resolve. README prerequisites = install.sh `for cmd` list (jq python3 cmp git claude) + grep -P; flags `--host`, `-h|--help`; exit 3 documented; `CLAUDE_CONFIG_DIR`, toolbox, `marketplace remove`, `{default}` period, literal braces, host-file keys and the snapshot stop documented; render-settings.py docstring says the same; `./install.sh -h` prints the usage line. README wording "leaves ~/.claude as it was" corrected to "exits before any file is installed or backed up" (claude creates its own state files on a fresh HOME). PASS.

### G15 attempt 1
- Repo root, branch main, no commits yet. Before: status showed `AD` for the four paths, all absent from the working tree. `git rm --cached --quiet --` on them. After: `git status --short` has no `AD` lines (README.md `AM` and untracked files unchanged); `git ls-files --stage` lists none of them. Blob ids, restorable with `git update-index --add --cacheinfo 100644,<blob>,<path>` until gc prunes them: prompt-audit-2026-10-25.md 72d1e9e2…, proposed/CLAUDE.md.diff ccbca36f…, proposed/agents/Explore.md 82fcb8eb…, proposed/settings.json.diff f8d5b472…. PASS.

Baseline (2026-10-28): repo untracked except staged `AD` entries; sha256 install.sh b363c0d8…, settings.json b48c26d2…, make-proposal.py 50d417a3…; `jq -S` repo settings.json == live ~/.claude/settings.json.

## Decisions and scope changes

- `Sensitive data locations` is overridden in full by hosts/ai.json (keeps the live wording byte-identical, criterion 1); base holds a shorter every-machine version. A host file replaces a base slot, it doesn't append.
- `soft_deny` verification checks that the custom rules are the tail of the effective list, since `$defaults` expands to the live built-in rules.
- Login check uses `claude auth status` → `.loggedIn`; logged-out exits 3 after installing files.
- Host name from `uname -n` instead of `hostname -s` (no `hostname` in minimal Fedora); `cmp` made a required prerequisite (found in G05 attempt 1).
- README re-lists `skills/plan-execution/` (installed by install.sh but missing from README).
- `hooks/make-proposal.py` removed, replaced by `hooks/render-settings.py` (approved step 2).
- **Scope change, 2026-10-28 (approval: user message "all of it, go ahead" replying to the review-fix recommendation in this session).** Follow-up after an external review was validated. Approved items:
  1. install.sh checks before changing anything: dependencies (add git, find), hook self-test on the repo copy, render to a temp file; jq/find failures stop the run instead of reading as empty.
  2. One install helper: backs up every replaced file (incl. test-bash-guard.sh), repairs mode-only drift; directories created only when missing (no chmod of existing ones); `mv -f`.
  3. Verification: effective soft_deny = built-in rules + custom (not just the tail); stop before changes when `claude auto-mode defaults` differs from automode/defaults.json.
  4. render-settings.py: literal braces except `{default}`/`{tail}`; fail when `{tail}` has no marker; reject unknown top-level keys; utf-8; usage string.
  5. Sensitive data locations: everything in base.json, slot removed from hosts/ai.json.
  6. Hostname: host's name inside a toolbox, lowercase, `--host` restricted to `[a-z0-9-]`.
  7. `CLAUDE_CONFIG_DIR`, marketplace repo and user-scope plugin checks, README `{default}` period and install.sh:11 comment.
  - Commit prep: `git rm --cached` the four staged `AD` entries (supersedes "don't touch the staged AD entries"). Commit, repo creation and push stay gated (T05/G07).
  - Verification in a throwaway HOME and in `dev-toolbox`, not on the live `~/.claude`; reinstalling on this machine changes `~/.claude` and needs separate approval.
  - Accepted/skipped: review #9, #12, #11b, backup timestamp resolution, .gitignore, Bash < 4.4, `cmp` exit 2, stale skill files.
  - Criterion 1 / G01 (render == live) no longer holds once item 5 changes the policy text; G09 replaces it until the live install. G02, G04, G06 are re-proven by G08, G10, G14; G03 (live install) and G05 (container) are STALE and not rerun here.
  - Found during G09: live `~/.claude/settings.json` has Opus `effortLevel: xhigh` from the user's `/effort`; repo settings.json says `medium`, so the next install reverts it unless the repo is updated. Not changed here (not in scope); reported to the user.
  - Item 1 implemented with bash `globstar` instead of `find` for skills/: no find dependency and no process substitution, so `find` is not added to the prerequisites. The marketplace/plugin lists are read from the rendered file in step 3, so a bad entry stops the run before installs.
  - Found while writing G12: expanding `"$defaults"` only where settings.json declares it would still pass if base.json lost `"$defaults"` (review #5). Fixed twice: render-settings.py requires soft_deny to start with `"$defaults"`, and step 7 always expects built-in soft_deny + custom.
  - Claude commands inside the plugin loops read `</dev/null` so they can't consume the list being iterated.
  - Pre-change sha256 prefixes: install.sh bcbe295a9ad7, render-settings.py f600fe17b85a, base.json 6f2b9bc9124e, hosts/ai.json eacc1bbc7ad3, README.md f0a69b837752.

## Handoff

- Outcome so far: T01–T04 and the review follow-up T06–T10 done; every follow-up gate (G08–G15) PASS against the final files (install.sh a9b7a8c30dc4…, render-settings.py ecdbb1bb72d9…, base.json d731db66ef9e…, hosts/ai.json 1c249bcfc0bf…).
- Open gates and blockers: G07 / T05 need approval (commit, `gh repo create --private`, push). G03 (live install on ai) is STALE and needs approval because it changes `~/.claude`: the Sensitive data slot lead phrase, `~/.claude/CLAUDE.md` mode 664 → 644, and Opus `effortLevel` back to the repo's `medium` unless repo settings.json is first updated to the user's `/effort xhigh`. G01 superseded by G09; G05 (container) not rerun, covered by G11/G12 in throwaway HOMEs.
- Limitations: plugin installs were stubbed in G11/G12 (real installs were proven in G05 attempt 3; the changed code is only the presence checks); tested on Fedora 44 with claude 2.1.312 only.
- Exact next action: user decides on Opus effortLevel in settings.json and approves (a) `./install.sh` on ai and (b) commit, repo creation and push.
