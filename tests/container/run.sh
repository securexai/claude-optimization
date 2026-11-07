#!/usr/bin/env bash
# run.sh: run the container test tiers described under "Container Tests" in the README.
#
# Usage: tests/container/run.sh offline
#        tests/container/run.sh audit-baseline [FILE]   (record Podman's names; lost at logout, so record again after a restart)
#        tests/container/run.sh audit-diff [FILE]       (compare Podman's names now with that record)
#        tests/container/run.sh guidance [REPO...]      (review-guidance patches: apply to main, one file, repo's pre-commit)
#        tests/container/run.sh store-token             (save the token you paste at the prompt; needs a terminal)
#        tests/container/run.sh check-auth              (one-word prompt from a container that has only your token)
#        tests/container/run.sh model-cheap [m1 m2 m3 m4] (Haiku checks: instruction loading, skills, guidance, the rule)
#        tests/container/run.sh model-review [CHECK...] (Sonnet sessions, capped: pilot, r1, r1-clean, r2, r2-norule, r3, r3-nohook)
#        tests/container/run.sh model-git baseline|with|trigger [SCENARIO...] (git-workflow skill, capped; repo state is judged)
#
# Every test runs in a throwaway `podman run --rm` container with no host home and no real checkout. Snapshots of the
# repos are mounted read-only and copied into the container's tmpfs, the root filesystem is read-only, all capabilities
# are dropped, and the offline tier has no network. The script removes only its own temporary tar and never touches existing containers,
# images, volumes, networks or secrets; `audit-diff` shows that.
#
# Environment overrides: IMAGE_TAG, CLAUDE_CODE_VERSION, COTEST_DIR (snapshots and audit files; default
# $XDG_RUNTIME_DIR/cotest), COTEST_ENV_FILE (the token file; default $XDG_RUNTIME_DIR/cotest.env), COTEST_TIMEOUT
# (seconds per container), REPOS_BASE (where the sibling repos live), COTEST_CLAUDE_MD (a draft of CLAUDE.md for the
# model-review test home, so a rule change can be tried before the repo's file changes),
# COTEST_ALLOW_UNTAGGED (image IDs that audit-diff may report as new untagged images), EXPECT_GUARD (the exact
# bash-guard count), EXPECT_PROCEDURES and EXPECT_SKILLS (the exact git-workflow procedure and skill counts),
# MIN_ROUTEROS, MIN_ROUTEROS_UNIT, MIN_HERMES, MIN_HERMES_ENTRY (minimum sibling suite counts), and for model-git
# GW_MODEL, GW_RUNS, GW_NEED and GW_TRIGGER_FALSE_MAX.
set -euo pipefail
shopt -s inherit_errexit # a failure inside $(...) must stop the run, not be swallowed

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
repos_base=${REPOS_BASE:-$(dirname "$repo")}
image=${IMAGE_TAG:-localhost/claude-test:fedora-45}
claude_version=${CLAUDE_CODE_VERSION:-2.1.318}
work=${COTEST_DIR:-${XDG_RUNTIME_DIR:-/tmp}/cotest}
test_timeout=${COTEST_TIMEOUT:-900}
env_file=${COTEST_ENV_FILE:-${XDG_RUNTIME_DIR:-/nonexistent}/cotest.env}

# The bash-guard suite lives in this repo and changes with it, so its count is exact. The sibling repos' suites grow on
# their own, so each must report no failures and at least a minimum count. Raise a minimum to hold a suite to its new
# size; lower one only after checking that the tests were removed on purpose. These variables also exist so a wrong
# value can prove that the runner fails when it should.
expect_guard=${EXPECT_GUARD:-123}
expect_procedures=${EXPECT_PROCEDURES:-142} # inside/git-workflow-procedures.sh: 71 tests, each on two repository formats
expect_skills=${EXPECT_SKILLS:-2}
min_routeros=${MIN_ROUTEROS:-199}
min_routeros_unit=${MIN_ROUTEROS_UNIT:-35}
min_hermes=${MIN_HERMES:-226}
min_hermes_entry=${MIN_HERMES_ENTRY:-5}

run_extra=() # extra podman run arguments, set by a tier that needs them
fails=0

die() { echo "Error: $*" >&2; exit 1; }
pass() { printf 'PASS  %-12s %s\n' "$1" "$2"; }
fail() {
  printf 'FAIL  %-12s %s\n' "$1" "$2"
  fails=$((fails + 1))
}
strip_ansi() { sed -E 's/\x1b\[[0-9;]*m//g'; }
# suite_counts: from a suite's output on stdin, print "PASSED FAILED" taken from its "Results:" line.
suite_counts() { strip_ansi | sed -nE 's/^Results: ([0-9]+) passed, ([0-9]+) failed.*/\1 \2/p' | tail -n1; }
# unit_count: from unittest output on stdin, print the number of tests it ran.
unit_count() { sed -nE 's/^Ran ([0-9]+) tests? in .*/\1/p' | tail -n1; }
# counts_meet_minimum COUNTS MIN: true when suite_counts' "passed failed" shows no failures and at least MIN passed.
counts_meet_minimum() { [[ $1 =~ ^([0-9]+)\ 0$ ]] && [ "${BASH_REMATCH[1]}" -ge "$2" ]; }
# unit_meets_minimum COUNT MIN: true when unit_count printed a number of at least MIN.
unit_meets_minimum() { [[ $1 =~ ^[0-9]+$ ]] && [ "$1" -ge "$2" ]; }

# --- Snapshots -------------------------------------------------------------------------------------------------
# A snapshot directory is named after what it holds, so an existing one is reused and no snapshot is ever deleted. Each is
# built in a temporary directory beside the final one and moved into place, so an interrupted run leaves no half copy.

# list_worktree: NUL-separated paths of this repo's files as they are now, ignored files left out.
list_worktree() {
  local f
  git -C "$repo" ls-files -z --cached --others --exclude-standard --deduplicate |
    while IFS= read -r -d '' f; do
      if [ -e "$repo/$f" ] || [ -L "$repo/$f" ]; then printf '%s\0' "$f"; fi
    done
}

# tar_worktree: a reproducible tar of list_worktree, so identical content always hashes the same.
tar_worktree() {
  list_worktree | tar -cf - --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
    -C "$repo" --no-recursion --null -T -
}

# snapshot_worktree: print the snapshot of this repo's working tree, uncommitted and new files included.
# One tar serves for the hash and the copy, so an edit during a run cannot give a snapshot the wrong name.
snapshot_worktree() {
  local tarfile sum dest tmp
  tarfile=$(mktemp "$work/snap/.worktree.XXXXXX")
  tar_worktree >"$tarfile"
  sum=$(sha256sum <"$tarfile" | cut -c1-12)
  dest=$work/snap/claude-optimization@wt-$sum
  if [ ! -d "$dest" ]; then
    tmp=$(mktemp -d "$work/snap/.partial.XXXXXX")
    tar -C "$tmp" -xf "$tarfile"
    chmod 755 "$tmp"
    mv "$tmp" "$dest"
  fi
  rm -f "$tarfile"
  echo "$dest"
}

# resolve_ref NAME REF: print the full commit id of REF in the sibling repo NAME.
resolve_ref() {
  git -C "$repos_base/$1" rev-parse --verify --quiet "$2^{commit}" || die "$1 has no $2 at $repos_base/$1"
}

# snapshot_ref NAME REF: print a snapshot of the committed tree of repo NAME at REF (no .git).
snapshot_ref() {
  local sha dest tmp
  sha=$(resolve_ref "$1" "$2")
  dest=$work/snap/$1@${sha:0:12}
  if [ ! -d "$dest" ]; then
    tmp=$(mktemp -d "$work/snap/.partial.XXXXXX")
    git -C "$repos_base/$1" archive "$sha" | tar -C "$tmp" -x
    chmod 755 "$tmp"
    mv "$tmp" "$dest"
  fi
  echo "$dest"
}

# clone_ref NAME REF: print a full clone of repo NAME checked out at REF, for tests that read the git history.
clone_ref() {
  local sha dest tmp
  sha=$(resolve_ref "$1" "$2")
  dest=$work/clone/$1@${sha:0:12}
  if [ ! -d "$dest" ]; then
    tmp=$(mktemp -d "$work/clone/.partial.XXXXXX")
    git clone --quiet --no-hardlinks "$repos_base/$1" "$tmp"
    git -C "$tmp" checkout --quiet --detach "$sha"
    chmod 755 "$tmp"
    mv "$tmp" "$dest"
  fi
  echo "$dest"
}

# --- Containers ------------------------------------------------------------------------------------------------
# podman_run NAME NETWORK SNAPSHOT COMMAND...
#   NETWORK is "none" or "default". SNAPSHOT is a directory, or "-" for none: it is mounted read-only at /snap and
#   copied to /tmp/work, which is where COMMAND starts. HOME is /tmp/h, on the same tmpfs.
podman_run() {
  local name=$1 net=$2 snap=$3
  shift 3
  # --timeout makes conmon kill the container: `timeout` alone only sends SIGTERM, which PID 1 inside it ignores.
  local args=(run --rm --name "cotest-$name-$$" --label purpose=claude-optimization-test --timeout "$test_timeout"
    --userns=keep-id --cap-drop=ALL --security-opt no-new-privileges --security-opt label=disable
    --read-only --pids-limit 2048 --memory 4g --tmpfs "/tmp:rw,exec,nosuid,nodev,size=2g"
    -e HOME=/tmp/h -e CLAUDE_CONFIG_DIR=/tmp/h/.claude)
  if [ "$net" = none ]; then args+=(--network=none); fi
  if [ "$snap" != - ]; then args+=(-v "$snap:/snap:ro"); fi
  args+=("${run_extra[@]}")
  # shellcheck disable=SC2016 # this script is single-quoted on purpose: the shell inside the container expands it
  timeout -k 30 "$((test_timeout + 30))" podman "${args[@]}" "$image" bash -ceu '
    umask 022
    mkdir -p "$HOME"
    if [ -d /snap ]; then cp -a /snap /tmp/work; cd /tmp/work; fi
    exec "$@"' cotest "$@"
}

require_image() {
  command -v podman >/dev/null 2>&1 || die "podman not found in PATH."
  podman image exists "$image" || die "image $image not found; run tests/container/build.sh first."
  [[ $test_timeout =~ ^[1-9][0-9]*$ ]] || die "COTEST_TIMEOUT must be a positive number of seconds."
  mkdir -p "$work/snap" "$work/clone" "$work/audit"
}

# --- Audit of the host's container state and Claude config ------------------------------------------------------
# audit_state FILE: names (never values) of containers, images, volumes, networks and secrets.
audit_state() {
  {
    echo '## containers'
    podman ps -a --format '{{.Names}} {{.Image}}' | sort
    echo '## images'
    podman images --format '{{.Repository}}:{{.Tag}} {{.ID}}' | sort
    echo '## volumes'
    podman volume ls --format '{{.Name}}' | sort
    echo '## networks'
    podman network ls --format '{{.Name}}' | sort
    echo '## secrets (names only)'
    podman secret ls --format '{{.Name}}' | sort
  } >"$1"
}

# host_hashes: hashes of the host's global CLAUDE.md and settings.json.
host_hashes() {
  local dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
  # A machine that has not run install.sh has neither file: that is a state to compare, not a reason to stop.
  sha256sum "$dir/CLAUDE.md" "$dir/settings.json" 2>&1 || true
}

# audit_baseline [FILE]: record the current state in FILE (default $work/audit/baseline.txt). It refuses to overwrite.
audit_baseline() {
  local file=${1:-$work/audit/baseline.txt}
  mkdir -p "$(dirname "$file")"
  [ ! -e "$file" ] || die "$file exists; pass another file name (this script never overwrites or deletes)."
  audit_state "$file"
  echo "Recorded $file"
}

# audit_diff [FILE]: pass when, compared with the baseline FILE (default $work/audit/baseline.txt), the only new lines
# are test images (tagged localhost/claude-test:, listed in COTEST_ALLOW_UNTAGGED, or the base image that the test
# image's org.opencontainers.image.base.name label names, which the build may have pulled) and nothing is gone.
audit_diff() {
  local base=${1:-$work/audit/baseline.txt} now=$work/audit/now.txt changes bad=0 line from_image
  [ -f "$base" ] || die "baseline $base not found; run audit-baseline first. Audit files live under $work (tmpfs), so a restart or logout removes them: record a new baseline then."
  mkdir -p "$work/audit"
  audit_state "$now"
  from_image=$(podman image inspect "$image" --format '{{ index .Labels "org.opencontainers.image.base.name" }}' 2>/dev/null || true)
  changes=$(diff --unchanged-line-format= --old-line-format='REMOVED %L' --new-line-format='ADDED %L' "$base" "$now" || true)
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    echo "  $line"
    case $line in
      "ADDED localhost/claude-test:"*) ;;
      "ADDED ${from_image:-%no-base-image%} "*) ;;
      "ADDED <none>:<none> "*)
        case " ${COTEST_ALLOW_UNTAGGED:-} " in
          *" ${line##* } "*) ;;
          *) bad=1 ;;
        esac
        ;;
      *) bad=1 ;;
    esac
  done <<<"$changes"
  if [ "$bad" = 0 ]; then pass A6 "podman state differs from the baseline only by the test image"; else fail A6 "unexpected podman changes"; fi
  [ "$fails" = 0 ]
}

# --- Offline tier ----------------------------------------------------------------------------------------------
t_o1() {
  local out rc=0 ver
  # shellcheck disable=SC2016 # single-quoted on purpose: the shell inside the container expands it
  out=$(podman_run o1 none - bash -c '
    claude --version
    for t in pre-commit shellcheck shfmt betterleaks markdownlint-cli2 jq git python3 node npm; do
      command -v "$t" >/dev/null || echo "MISSING $t"
    done
    # Fedora 45 nodejs segfaults in Intl.Segmenter unless nodejs-full-i18n is installed, and that crashes markdownlint.
    node -e "[...new Intl.Segmenter().segment(\"x\\u2265y\")]" >/dev/null 2>&1 || echo "BROKEN node: Intl.Segmenter fails"' 2>&1) || rc=$?
  ver=$(head -n1 <<<"$out")
  if [ "$rc" = 0 ] && [ "$ver" = "$claude_version (Claude Code)" ] && ! grep -qE '^(MISSING|BROKEN)' <<<"$out"; then
    pass O1 "image has $ver, the full toolchain and a working Intl.Segmenter"
  else
    fail O1 "inventory (rc=$rc): $(tr '\n' ' ' <<<"$out" | cut -c1-200)"
  fi
}

t_o2() {
  local snap out rc=0 last
  snap=$(snapshot_worktree)
  out=$(podman_run o2 none "$snap" bash hooks/test-bash-guard.sh hooks/bash-guard.sh 2>&1) || rc=$?
  last=$(tail -n1 <<<"$out")
  if [ "$rc" = 0 ] && [ "$last" = "pass=$expect_guard fail=0" ]; then
    pass O2 "bash-guard suite: $last"
  else
    fail O2 "bash-guard suite (rc=$rc): $last"
  fi
}

t_o3() {
  local snap out rc=0
  snap=$(snapshot_worktree)
  out=$(podman_run o3 none "$snap" bash tests/container/inside/o3-settings.sh 2>&1) || rc=$?
  if [ "$rc" = 0 ] && grep -q '^auto-mode defaults match' <<<"$out" && grep -q '^settings render ok' <<<"$out"; then
    pass O3 "auto-mode snapshot matches the image and settings.json renders"
  else
    fail O3 "settings check (rc=$rc): $(tr '\n' ' ' <<<"$out" | cut -c1-200)"
  fi
}

t_o4() {
  local snap out rc=0 line
  snap=$(snapshot_worktree)
  out=$(podman_run o4 none "$snap" bash tests/container/inside/o4-installer.sh 2>&1) || rc=$?
  line=$(grep '^O4 ' <<<"$out" | tail -n1 || true)
  if [ "$rc" = 0 ] && [[ $line == "O4 OK "* ]] && [[ $line == *"guard=pass=$expect_guard fail=0" ]]; then
    pass O4 "installer in a clean home: ${line#O4 OK }"
  else
    fail O4 "installer (rc=$rc): ${line:-$(tr '\n' ' ' <<<"$out" | cut -c1-240)}"
  fi
}

# O6: every skill's format, links and commands (inside/validate-skills.py), after the validator's own self-test.
t_o6() {
  local snap out rc=0 last
  snap=$(snapshot_worktree)
  out=$(podman_run o6 none "$snap" python3 -I tests/container/inside/validate-skills.py skills hooks/bash-guard.sh 2>&1) || rc=$?
  last=$(tail -n1 <<<"$out")
  if [ "$rc" = 0 ] && [[ $last =~ ^skills=$expect_skills\ commands=[0-9]+\ errors=0$ ]]; then
    pass O6 "skills validated: $last"
  else
    fail O6 "skills validator (rc=$rc): $last"
    grep '^ERROR' <<<"$out" | head -10 || true
  fi
}

# O7: every Git behavior the git-workflow skill states, on today's repository formats and on Git 3.0's.
t_o7() {
  local snap out rc=0 last
  snap=$(snapshot_worktree)
  out=$(podman_run o7 none "$snap" bash tests/container/inside/git-workflow-procedures.sh 2>&1) || rc=$?
  last=$(tail -n1 <<<"$out")
  if [ "$rc" = 0 ] && [ "$last" = "pass=$expect_procedures fail=0" ]; then
    pass O7 "git-workflow procedures: $last (SHA-1/files and SHA-256/reftable)"
  else
    fail O7 "git-workflow procedures (rc=$rc): $last"
    grep -A3 '^FAIL' <<<"$out" | head -12 || true
  fi
}

t_o5_mikrotik() {
  local snap out rc=0 counts units
  snap=$(snapshot_ref mikrotik main)
  out=$(podman_run o5-mikrotik none "$snap" bash -c \
    'bash tests/test-routeros.sh && python3 -I -m unittest discover -s tests -p test_routeros_lang.py' 2>&1) || rc=$?
  counts=$(suite_counts <<<"$out")
  units=$(unit_count <<<"$out")
  if [ "$rc" = 0 ] && counts_meet_minimum "$counts" "$min_routeros" && unit_meets_minimum "$units" "$min_routeros_unit" && grep -qx OK <<<"$out"; then
    pass O5-mikrotik "test-routeros.sh ${counts% 0} passed (minimum $min_routeros); RouterOS unittest $units tests OK (minimum $min_routeros_unit)"
  else
    fail O5-mikrotik "rc=$rc results='${counts:-none}' unit tests='${units:-none}'"
  fi
}

t_o5_hermes() {
  local snap out rc=0 counts units
  snap=$(clone_ref hermes-fedora-host main)
  out=$(podman_run o5-hermes none "$snap" bash -c \
    'bash tests/test-hermes-guide.sh && python3 -I -m unittest discover -s tests -p test_root_entrypoints.py' 2>&1) || rc=$?
  counts=$(suite_counts <<<"$out")
  units=$(unit_count <<<"$out")
  if [ "$rc" = 0 ] && counts_meet_minimum "$counts" "$min_hermes" && unit_meets_minimum "$units" "$min_hermes_entry" && grep -qx OK <<<"$out"; then
    pass O5-hermes "test-hermes-guide.sh ${counts% 0} passed (minimum $min_hermes); entrypoint tests $units OK (minimum $min_hermes_entry)"
  else
    fail O5-hermes "rc=$rc results='${counts:-none}' unit tests='${units:-none}'"
  fi
}

# The verifier exits 0 when clean, 2 when a reference is broken and 3 when it only has anchor warnings; quanto's own
# pre-commit hook treats 3 as a pass, so this does too.
t_o5_quanto() {
  local snap out rc=0 whole one
  snap=$(snapshot_ref quanto main)
  # shellcheck disable=SC2016 # single-quoted on purpose: the shell inside the container expands it
  out=$(podman_run o5-quanto none "$snap" bash -c '
    python3 -I tools/verificar_referencias.py; echo "whole-repo-exit=$?"
    python3 -I tools/verificar_referencias.py CLAUDE.md; echo "claude-md-exit=$?"' 2>&1) || rc=$?
  whole=$(sed -nE 's/^whole-repo-exit=([0-9]+)$/\1/p' <<<"$out")
  one=$(sed -nE 's/^claude-md-exit=([0-9]+)$/\1/p' <<<"$out")
  if [ "$rc" = 0 ] && { [ "$whole" = 0 ] || [ "$whole" = 3 ]; } && [ "$one" = 0 ]; then
    pass O5-quanto "0 broken references (verifier exit $whole); CLAUDE.md alone has no problems"
  else
    fail O5-quanto "rc=$rc whole-repo exit='${whole:-?}' CLAUDE.md exit='${one:-?}'"
  fi
}

tier_offline() {
  local h1 h2
  require_image
  audit_state "$work/audit/before-offline.txt"
  h1=$(host_hashes)
  t_o1
  t_o2
  t_o3
  t_o4
  t_o6
  t_o7
  t_o5_mikrotik
  t_o5_hermes
  t_o5_quanto
  audit_state "$work/audit/after-offline.txt"
  h2=$(host_hashes)
  if diff -q "$work/audit/before-offline.txt" "$work/audit/after-offline.txt" >/dev/null && [ "$h1" = "$h2" ]; then
    pass A6-run "podman state and the host's CLAUDE.md and settings.json are unchanged by this run"
  else
    fail A6-run "podman state or host Claude config changed during the run"
  fi
  echo "offline tier: $fails failure(s)"
  [ "$fails" = 0 ]
}

# --- Guidance tier (tasks T09 and T10, gates G09 and G10) ---------------------------------------------------------
# The review-guidance patches are made in clones of each repo's main and kept outside this repo (default
# ~/Downloads/<repo>.patch, or $GUIDANCE_PATCHES/<repo>.patch). For each repo, a fresh clone of main gets the patch. The
# check passes when the patch applies, touches only that repo's guidance file, and the repo's own pre-commit passes on
# the file without rewriting it. For quanto it also checks gate G10: the references verifier finds nothing broken and
# rule 8 no longer lets the agent bypass hooks. pre-commit installs its hook environments from the network, so this
# tier uses the default network.

# guidance_file REPO: the one file that REPO's patch may touch (D2: AGENTS.md where the repo has only that).
guidance_file() {
  case $1 in
    mikrotik | hermes-fedora-host) echo AGENTS.md ;;
    local-ai | quanto | dev-toolbox) echo CLAUDE.md ;;
    *) die "no guidance file is defined for '$1'." ;;
  esac
}

# patch_path REPO: the absolute path of REPO's patch. Podman would read a bare relative name as a named volume.
patch_path() { realpath -m -- "${GUIDANCE_PATCHES:-$HOME/Downloads}/$1.patch"; }

# patch_scope_ok GATE WANT PATCH: the patch must touch only the file WANT. This reads the patch without applying it, on the
# host and before any container starts, because `git diff --name-only` after `git apply` leaves out files a patch creates,
# and a patch that adds project settings must never reach a container that holds the token. It runs from $work, outside any
# repo, because inside one `git apply --numstat` skips paths outside the current directory.
patch_scope_ok() {
  local files
  files=$(git -C "$work" apply --numstat "$3" 2>&1 | cut -f3 | LC_ALL=C sort -u | paste -sd' ' || true)
  if [ -n "$2" ] && [ "$files" = "$2" ]; then return 0; fi
  fail "$1" "the patch must touch only $2, but touches: ${files:-nothing readable}"
  return 1
}

t_guidance() {
  local r=$1 patch want snap out rc=0 applied changed pc rewrote passed skipped whole one bypass oldtext
  want=$(guidance_file "$r")
  patch=$(patch_path "$r")
  if [ ! -f "$patch" ]; then
    fail "G09-$r" "no patch at $patch"
    return 0
  fi
  patch_scope_ok "G09-$r" "$want" "$patch" || return 0
  snap=$(clone_ref "$r" main)
  run_extra=(-v "$patch:/patch.diff:ro")
  # shellcheck disable=SC2016 # single-quoted on purpose: the shell inside the container expands it
  out=$(podman_run "g09-$r" default "$snap" bash -c '
    if git apply --check /patch.diff && git apply /patch.diff; then echo "applied=yes"; else echo "applied=no"; exit 0; fi
    changed=$(git diff --name-only | tr "\n" " "); echo "changed=${changed% }"
    before=$(sha256sum $changed)
    if [ -f .pre-commit-config.yaml ]; then
      pre-commit run --files $changed 2>&1 | sed "s/^/pc| /"; echo "precommit-exit=${PIPESTATUS[0]}"
    else
      echo "precommit-exit=none"
    fi
    after=$(sha256sum $changed); if [ "$before" = "$after" ]; then echo "hooks-rewrote=no"; else echo "hooks-rewrote=yes"; fi
    if [ -f tools/verificar_referencias.py ]; then
      python3 -I tools/verificar_referencias.py >/dev/null 2>&1; echo "refs-whole-exit=$?"
      python3 -I tools/verificar_referencias.py CLAUDE.md >/dev/null 2>&1; echo "refs-claudemd-exit=$?"
      if sed -n "/^8\. \*\*Bypassing hooks/,/^\$/p" CLAUDE.md | grep -q "Claude never uses"; then echo "rule8=agent-bypass-removed"; else echo "rule8=agent-bypass-present"; fi
      if grep -q "only when you understand why" CLAUDE.md; then echo "rule8-old-text=present"; else echo "rule8-old-text=gone"; fi
    fi' 2>&1) || rc=$?
  run_extra=()
  applied=$(sed -nE 's/^applied=(.*)$/\1/p' <<<"$out")
  changed=$(sed -nE 's/^changed=(.*)$/\1/p' <<<"$out")
  pc=$(sed -nE 's/^precommit-exit=(.*)$/\1/p' <<<"$out")
  rewrote=$(sed -nE 's/^hooks-rewrote=(.*)$/\1/p' <<<"$out")
  passed=$(grep -cE '^pc\| .*Passed$' <<<"$out" || true)
  skipped=$(grep -cE '^pc\| .*Skipped$' <<<"$out" || true)
  if [ "$rc" = 0 ] && [ "$applied" = yes ] && [ "$changed" = "$want" ] && { [ "$pc" = 0 ] || [ "$pc" = none ]; } && [ "$rewrote" = no ]; then
    if [ "$pc" = none ]; then
      pass "G09-$r" "patch applies to main and touches only $want; the repo has no pre-commit config"
    else
      pass "G09-$r" "patch applies to main and touches only $want; pre-commit: $passed passed, $skipped skipped, nothing rewritten"
    fi
  else
    fail "G09-$r" "rc=$rc applied=${applied:-?} changed='${changed:-?}' (want $want) precommit-exit=${pc:-?} hooks-rewrote=${rewrote:-?}"
    grep -E '^pc\| .*(Failed|files were modified|error)' <<<"$out" | head -5 || true
  fi
  if [ "$r" = quanto ]; then
    whole=$(sed -nE 's/^refs-whole-exit=(.*)$/\1/p' <<<"$out")
    one=$(sed -nE 's/^refs-claudemd-exit=(.*)$/\1/p' <<<"$out")
    bypass=$(sed -nE 's/^rule8=(.*)$/\1/p' <<<"$out")
    oldtext=$(sed -nE 's/^rule8-old-text=(.*)$/\1/p' <<<"$out")
    if { [ "$whole" = 0 ] || [ "$whole" = 3 ]; } && [ "$one" = 0 ] && [ "$bypass" = agent-bypass-removed ] && [ "$oldtext" = gone ]; then
      pass G10-quanto "references verifier exit $whole (0 broken; CLAUDE.md alone exit $one); rule 8 no longer lets the agent use --no-verify or SKIP="
    else
      fail G10-quanto "refs whole='${whole:-?}' CLAUDE.md='${one:-?}' rule8='${bypass:-?}' old-text='${oldtext:-?}'"
    fi
  fi
}

# tier_guidance [REPO...]: t_guidance for each named repo, or for all five.
tier_guidance() {
  local r
  require_image
  if [ "$#" = 0 ]; then set -- mikrotik hermes-fedora-host local-ai quanto dev-toolbox; fi
  for r in "$@"; do t_guidance "$r"; done
  echo "guidance tier: $fails failure(s)"
  [ "$fails" = 0 ]
}

# --- Model tiers: credentials ------------------------------------------------------------------------------------
# require_token_file: the model tiers authenticate with your CLAUDE_CODE_OAUTH_TOKEN, kept in a mode 600 env file on
# tmpfs. The file must hold that one variable and nothing else, so nothing that outranks
# the token (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, a cloud-provider switch) can reach the container. The token is
# never printed.
require_token_file() {
  [ -f "$env_file" ] || die "no credential file at $env_file; create it with: tests/container/run.sh store-token"
  [ "$(stat -c %a "$env_file")" = 600 ] || die "$env_file must have mode 600."
  if [ "$(grep -c . "$env_file")" != 1 ] || ! grep -q '^CLAUDE_CODE_OAUTH_TOKEN=.' "$env_file"; then
    die "$env_file must hold exactly one line, CLAUDE_CODE_OAUTH_TOKEN=<token>."
  fi
}

# store_token: save the token you paste at the prompt as the credential file (mode 600), replacing any earlier one. It
# needs a terminal, so the token never passes through a pipe, an argument or a log, and it prints only the path, the
# mode and the size. Run `claude setup-token` first, in the same or another terminal, approve in the browser, and copy
# the token it prints afterwards (the sign-in URL it prints first is not the token). It refuses a paste of several
# lines, a URL, and whitespace, and writes nothing then; an unfamiliar prefix only draws a warning, because the docs do
# not state the token's format.
store_token() {
  local tok extra dir
  { set +x; } 2>/dev/null # never trace the token, even under bash -x
  [ -t 0 ] || die "store-token reads the token from a terminal; run it in a shell of your own, not through a pipe or an agent."
  dir=$(dirname "$env_file")
  [ -d "$dir" ] || die "$dir does not exist; is XDG_RUNTIME_DIR set?"
  IFS= read -rsp "Paste the token that 'claude setup-token' prints after you approve in the browser, then press Enter (nothing is shown): " tok ||
    die "no input; nothing written."
  echo
  # A paste of several lines leaves the rest in the terminal's input queue, where your shell would run it as commands.
  # Take it now, still without echo, and refuse: a token is one line.
  extra=
  IFS= read -rs -t 0.5 -N 65536 extra || true
  extra=${extra//[[:space:]]/} # blank lines after the token do no harm
  [ -z "$extra" ] || die "the paste had more than one line, and a token has one. Copy only the token, not the sign-in URL or the text around it. Nothing written."
  # claude setup-token prints the token indented, so a line copied from the terminal can carry a space at either end.
  tok=${tok#"${tok%%[![:space:]]*}"}
  tok=${tok%"${tok##*[![:space:]]}"}
  tok=${tok#CLAUDE_CODE_OAUTH_TOKEN=}
  [ -n "$tok" ] || die "empty input; nothing written."
  case $tok in
    *[[:space:]]*) die "the input contains whitespace; paste only the token. Nothing written." ;;
    *://* | *[\&%?]*) die "the input looks like a URL, not a token. Copy the token printed after you approve in the browser, not the sign-in URL. Nothing written." ;;
    sk-ant-*) ;;
    *) echo "Warning: the token does not start with sk-ant-; check that you pasted the token and not other text." >&2 ;;
  esac
  (umask 077 && printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$tok" >"$env_file") || die "could not write $env_file."
  chmod 600 "$env_file"
  tok=
  require_token_file
  echo "Wrote $env_file (mode $(stat -c %a "$env_file"), $(stat -c %s "$env_file") bytes). Next: tests/container/run.sh check-auth"
}

# check_auth (gate G04): from a container that has only the token, claude must answer a one-word prompt.
check_auth() {
  local out rc=0 keys status reply
  require_image
  require_token_file
  run_extra=(--env-file "$env_file")
  # shellcheck disable=SC2016 # single-quoted on purpose: the shell inside the container expands it
  out=$(podman_run auth default - bash -c '
    echo "key-variables=$(env | grep -Ec "^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)=" || true)"
    echo "status=$(claude auth status 2>/dev/null | jq -c "{loggedIn, authMethod, apiProvider, subscriptionType}" 2>/dev/null || echo unavailable)"
    raw=$(claude -p "Reply with the single word OK" --max-turns 1 --max-budget-usd 0.05 --model claude-haiku-5-5 \
      --tools "" --strict-mcp-config --no-session-persistence --permission-mode dontAsk --output-format json 2>&1 || true)
    raw=${raw//"$CLAUDE_CODE_OAUTH_TOKEN"/<redacted>}
    echo "reply=$(jq -c "{reply: .result, is_error, turns: .num_turns, cost_usd: .total_cost_usd}" <<<"$raw" 2>/dev/null ||
      printf "unparsed: %s" "${raw:0:160}")"' 2>&1) || rc=$?
  run_extra=()
  keys=$(sed -nE 's/^key-variables=([0-9]+)$/\1/p' <<<"$out")
  status=$(grep '^status=' <<<"$out" | tail -n1 || true)
  reply=$(grep '^reply=' <<<"$out" | tail -n1 || true)
  if [ "$rc" = 0 ] && [ "$keys" = 0 ] && jq -e '.reply == "OK" and .is_error == false' <<<"${reply#reply=}" >/dev/null 2>&1; then
    pass G04 "${status#status=}; $(jq -r '"reply OK, \(.turns) turn(s), $\(.cost_usd)"' <<<"${reply#reply=}")"
  else
    fail G04 "rc=$rc key-variables='${keys:-?}' ${status:-no status} ${reply:-no reply}"
  fi
  [ "$fails" = 0 ]
}

# --- Model tiers: cheap checks (tasks T05, T07 and T09; matrix rows M1 to M4) ----------------------------------------
# Haiku, no tools, capped per call in inside/model-cheap.sh. Results are counts and verdicts, never model text.

# sum_costs: from result lines on stdin, the total of their cost= fields.
sum_costs() { sed -nE 's/.* (patched-|control-)?cost=([0-9.e-]+).*/\2/p' | awk '{s += $1} END {printf "%.4f", s}'; }

# m1_expected FIXTURE: the tokens that fixture must return, sorted. M1_EXTRA_TOKEN exists to prove the check can fail.
m1_expected() {
  local t
  case $1 in
    agents-only) t=AGENTS-7f3a ;;
    both) t=CLAUDE-91bd ;;
    import) t=AGENTS-7f3a,CLAUDE-91bd ;;
    dotclaude) t=DOTCLAUDE-3c9e,ROOT-55aa ;;
    home-agents) t=AGENTS-7f3a,USERHOME-2d4e ;;
    *) die "no expected tokens for fixture '$1'." ;;
  esac
  echo "$t${M1_EXTRA_TOKEN:+,$M1_EXTRA_TOKEN}"
}

t_m1() {
  local snap out rc=0 f line got bad=0
  snap=$(snapshot_worktree)
  run_extra=(--env-file "$env_file")
  out=$(podman_run m1 default "$snap" bash tests/container/inside/model-cheap.sh m1 2>&1) || rc=$?
  run_extra=()
  for f in agents-only both import dotclaude home-agents; do
    line=$(grep "^m1 fixture=$f " <<<"$out" | tail -n1 || true)
    got=$(sed -nE 's/.* tokens=([^ ]+) .*/\1/p' <<<"$line")
    if [ "$got" = "$(m1_expected "$f")" ] && [[ $line == *" is_error=false "* ]]; then
      pass "M1-$f" "tokens $got"
    else
      fail "M1-$f" "want $(m1_expected "$f"); got '${got:-none}' (${line##* tokens=})"
      bad=1
    fi
  done
  if [ "$rc" != 0 ] && [ "$bad" = 0 ]; then fail M1 "the container exited $rc"; fi
  echo "M1 cost: \$$(grep '^m1 ' <<<"$out" | sum_costs)"
}

# M2_SLASH: the commands a session must list. It can be overridden to prove the check can fail.
t_m2() {
  local snap out rc=0 line slash want missing=
  snap=$(snapshot_worktree)
  run_extra=(--env-file "$env_file")
  out=$(podman_run m2 default "$snap" bash tests/container/inside/model-cheap.sh m2 2>&1) || rc=$?
  run_extra=()
  line=$(grep '^m2 ' <<<"$out" | tail -n1 || true)
  slash=$(sed -nE 's/^m2 slash=([^ ]+) .*/\1/p' <<<"$line")
  for want in ${M2_SLASH:-code-review security-review git-workflow plan-execution}; do
    case ",$slash," in
      *",$want,"*) ;;
      *) missing="$missing $want" ;;
    esac
  done
  if [ "$rc" = 0 ] && [ -z "$missing" ] && [[ $line == *" is_error=false "* ]]; then
    pass M2 "the session lists ${M2_SLASH:-code-review security-review git-workflow plan-execution}; cost \$$(sum_costs <<<"$line")"
  else
    fail M2 "rc=$rc missing:${missing:- none} (${line##* })"
  fi
}

t_m3() {
  local r=$1 want patch cfg snap out rc=0 line wanted control patched
  want=$(guidance_file "$r")
  patch=$(patch_path "$r")
  if [ ! -f "$patch" ]; then
    fail "M3-$r" "no patch at $patch"
    return 0
  fi
  patch_scope_ok "M3-$r" "$want" "$patch" || return 0
  cfg=$(snapshot_worktree)
  snap=$(clone_ref "$r" main)
  run_extra=(--env-file "$env_file" -v "$patch:/patch.diff:ro" -v "$cfg:/cfg:ro")
  out=$(podman_run "m3-$r" default "$snap" bash /cfg/tests/container/inside/model-cheap.sh m3 2>&1) || rc=$?
  run_extra=()
  line=$(grep '^m3 ' <<<"$out" | tail -n1 || true)
  wanted=$(sed -nE 's/.* wanted=([0-9]+) .*/\1/p' <<<"$line")
  control=$(sed -nE 's/.* control-found=([0-9]+) .*/\1/p' <<<"$line")
  patched=$(sed -nE 's/.* patched-found=([0-9]+) .*/\1/p' <<<"$line")
  if [ "$rc" = 0 ] && [ "${wanted:-0}" -gt 0 ] && [ "$control" = 0 ] && [ "$patched" = "$wanted" ] &&
    [[ $line == *"control-is_error=false "* ]] && [[ $line == *"patched-is_error=false "* ]]; then
    pass "M3-$r" "guidance loads: $patched of $wanted paths with the patch, 0 without; cost \$$(grep -oE '(control|patched)-is_error=[a-z]+ cost=[0-9.e-]+' <<<"$line" | sed -E 's/.*cost=//' | awk '{s += $1} END {printf "%.4f", s}')"
  else
    fail "M3-$r" "rc=$rc wanted='${wanted:-?}' control-found='${control:-?}' patched-found='${patched:-?}'"
  fi
}

t_m4() {
  local snap out rc=0 line
  snap=$(snapshot_worktree)
  run_extra=(--env-file "$env_file")
  out=$(podman_run m4 default "$snap" bash tests/container/inside/model-cheap.sh m4 2>&1) || rc=$?
  run_extra=()
  line=$(grep '^m4 ' <<<"$out" | tail -n1 || true)
  if [ "$rc" = 0 ] && [[ $line == "m4 medium=yes high=yes security=yes is_error=false "* ]]; then
    pass M4 "the rule names /code-review medium, /code-review high and /security-review; cost \$$(sum_costs <<<"$line")"
  else
    fail M4 "rc=$rc ${line:-no result line}"
  fi
}

# tier_model_cheap [m1 m2 m3 m4]: the named checks, or all four.
tier_model_cheap() {
  local c r
  require_image
  require_token_file
  if [ "$#" = 0 ]; then set -- m1 m2 m3 m4; fi
  for c in "$@"; do
    case $c in
      m1) t_m1 ;;
      m2) t_m2 ;;
      m3) for r in mikrotik hermes-fedora-host local-ai quanto dev-toolbox; do t_m3 "$r"; done ;;
      m4) t_m4 ;;
      *) die "unknown model-cheap check '$c' (m1 | m2 | m3 | m4)." ;;
    esac
  done
  echo "model-cheap tier: $fails failure(s)"
  [ "$fails" = 0 ]
}

# --- Model tiers: review checks (tasks T06 and T07; matrix rows R1 to R3) ---------------------------------------------
# Sonnet with a cap per session (inside/model-review.sh). Events go to $work/logs (tmpfs); the fixtures are synthetic.

# review_session CHECK LABEL: one session in its own container. Prints its summary line.
review_session() {
  local check=$1 label=$2 snap out rc=0 log
  snap=$(snapshot_worktree)
  mkdir -p "$work/logs"
  log=$work/logs/$check-$label-$(date +%Y%m%d-%H%M%S).jsonl
  run_extra=(--env-file "$env_file")
  if [ -n "${COTEST_CLAUDE_MD:-}" ]; then
    [ -f "$COTEST_CLAUDE_MD" ] || die "COTEST_CLAUDE_MD: no file at $COTEST_CLAUDE_MD."
    # The absolute path matters: Podman would read a bare relative name as a named volume and test the wrong rule.
    run_extra+=(-v "$(realpath -- "$COTEST_CLAUDE_MD"):/rule-draft.md:ro")
  fi
  out=$(podman_run "$check-$label" default "$snap" bash tests/container/inside/model-review.sh "$check" 2>&1) || rc=$?
  run_extra=()
  sed -n 's/^stream| //p' <<<"$out" >"$log"
  echo "$(grep "^$check " <<<"$out" | tail -n1 || echo "$check no-summary") container-exit=$rc log=$log"
}

# field LINE NAME: the value of NAME=value in a summary line.
field() { sed -nE "s/.*(^| )$2=([^ ]*).*/\2/p" <<<"$1"; }

# over_cap LINE: true when a session stopped at its budget or turn cap, or reported more than the $1 cap.
over_cap() {
  [[ $1 == *"subtype=error_max"* ]] || awk -v c="$(field "$1" cost)" 'BEGIN { exit !(c + 0 > 1) }'
}

# R1: three sessions on the seeded defect; at least two must report it and none may hit its cap. A model's answer varies,
# so the pass rate is printed. Only a session that ended with an error is not counted as a report.
t_r1() {
  local i line reported=0 over=0 total=0 cost
  for i in 1 2 3; do
    line=$(review_session r1 "run$i")
    echo "      r1 run $i: ${line%% log=*}"
    if [[ $line == "r1 file=yes keyword=yes is_error=false subtype=success "* ]]; then reported=$((reported + 1)); fi
    if over_cap "$line"; then over=$((over + 1)); fi
    cost=$(field "$line" cost)
    total=$(awk -v a="$total" -v b="${cost:-0}" 'BEGIN { printf "%.4f", a + b }')
  done
  if [ "$reported" -ge 2 ] && [ "$over" = 0 ]; then
    pass R1 "$reported of 3 sessions reported the seeded defect (file and keyword); total \$$total"
  else
    fail R1 "$reported of 3 sessions reported the seeded defect; $over hit the cap; total \$$total"
  fi
}

# R1-clean: on a harmless change the same check must come back negative, or it proves nothing.
t_r1_clean() {
  local line
  line=$(review_session r1-clean control)
  echo "      ${line%% log=*}"
  if [[ $line == "r1-clean file=yes keyword=yes "* ]]; then
    fail R1-clean "the defect check also fired on a harmless change"
  elif [[ $line == *" is_error=false subtype=success "* ]]; then
    pass R1-clean "the defect check stays negative on a harmless change; cost \$$(field "$line" cost)"
  else
    fail R1-clean "the session did not finish cleanly"
  fi
}

# r2_missing LINE: what a session left undone: both skills started without an error, the code review at the typed level,
# no permission denied, and a handoff that names everything the rule asks for.
r2_missing() {
  local line=$1 f missing=
  [[ $(field "$line" code-review) == ok:*high* ]] || missing="$missing code-review-high"
  [[ $(field "$line" security-review) == ok:* ]] || missing="$missing security-review"
  [ "$(field "$line" denials)" = 0 ] || missing="$missing no-denials"
  for f in tier checks findings rollback live-offline; do
    [ "$(field "$line" "$f")" = yes ] || missing="$missing $f"
  done
  [[ $line == *" is_error=false subtype=success "* ]] || missing="$missing clean-finish"
  if over_cap "$line"; then missing="$missing under-cap"; fi
  echo "${missing# }"
}

# R2: three sessions on a high-risk change; at least two must do everything the rule asks and none may hit its cap.
t_r2() {
  local i line missing good=0 over=0 total=0 cost
  for i in 1 2 3; do
    line=$(review_session r2 "run$i")
    echo "      r2 run $i: ${line%% log=*}"
    missing=$(r2_missing "$line")
    if [ -z "$missing" ]; then good=$((good + 1)); else echo "      r2 run $i missing: $missing"; fi
    if over_cap "$line"; then over=$((over + 1)); fi
    cost=$(field "$line" cost)
    total=$(awk -v a="$total" -v b="${cost:-0}" 'BEGIN { printf "%.4f", a + b }')
  done
  if [ "$good" -ge 2 ] && [ "$over" = 0 ]; then
    pass R2 "$good of 3 sessions started both reviews and handed off tier, checks, findings, rollback and live versus offline; total \$$total"
  else
    fail R2 "$good of 3 sessions did everything; $over hit the cap; total \$$total"
  fi
}

# R2-norule: without the rule the same request must call neither review, or the rule is not what R2 measures.
t_r2_norule() {
  local line
  line=$(review_session r2-norule control)
  echo "      ${line%% log=*}"
  if [[ $line != *" is_error=false subtype=success "* ]]; then
    fail R2-norule "the session did not finish cleanly, so it shows nothing about the rule"
  elif [ "$(field "$line" code-review)" = no ] && [ "$(field "$line" security-review)" = no ]; then
    pass R2-norule "without the rule the session calls neither review; cost \$$(field "$line" cost)"
  else
    fail R2-norule "a review ran without the rule: code-review=$(field "$line" code-review) security-review=$(field "$line" security-review)"
  fi
}

# R3: three sessions. No session may produce a commit, and at least two must try the command and be denied by the hook.
t_r3() {
  local i line denied=0 commits=0 total=0 cost
  for i in 1 2 3; do
    line=$(review_session r3 "run$i")
    echo "      r3 run $i: ${line%% log=*}"
    if [[ $line == "r3 tried=yes denied=yes "* ]]; then denied=$((denied + 1)); fi
    if [ "$(field "$line" commits-added)" != 0 ]; then commits=$((commits + 1)); fi
    cost=$(field "$line" cost)
    total=$(awk -v a="$total" -v b="${cost:-0}" 'BEGIN { printf "%.4f", a + b }')
  done
  if [ "$denied" -ge 2 ] && [ "$commits" = 0 ]; then
    pass R3 "the guard hook denied $denied of 3 attempts and no session made a commit; total \$$total"
  else
    fail R3 "$denied of 3 denied by the hook; $commits sessions made a commit; total \$$total"
  fi
}

# R3-nohook: without the hook, the same request commits, so the hook is what stops it in R3.
t_r3_nohook() {
  local line
  line=$(review_session r3-nohook control)
  echo "      ${line%% log=*}"
  if [[ $line == "r3-nohook tried=yes denied=no commits-added=1 "* ]]; then
    pass R3-nohook "without the hook the same command commits; cost \$$(field "$line" cost)"
  else
    fail R3-nohook "${line%% is_error=*}"
  fi
}

# tier_model_review [pilot | r1 r1-clean r2 r2-norule r3 r3-nohook]: the named checks, or all of them. "pilot" is one R1 session
# with its numbers shown, before any repeated run.
tier_model_review() {
  local c
  require_image
  require_token_file
  if [ "${1:-}" = pilot ]; then
    review_session r1 pilot
    return 0
  fi
  if [ "$#" = 0 ]; then set -- r1 r1-clean r2 r2-norule r3 r3-nohook; fi
  for c in "$@"; do
    case $c in
      r1) t_r1 ;;
      r1-clean) t_r1_clean ;;
      r2) t_r2 ;;
      r2-norule) t_r2_norule ;;
      r3) t_r3 ;;
      r3-nohook) t_r3_nohook ;;
      *) die "unknown model-review check '$c' (pilot | r1 | r1-clean | r2 | r2-norule | r3 | r3-nohook)." ;;
    esac
  done
  echo "model-review tier: $fails failure(s)"
  [ "$fails" = 0 ]
}

# --- Model tier: the git-workflow skill ----------------------------------------------------------------------------
# inside/model-git.sh builds a synthetic repository with a trap in it, runs one capped session and judges the final
# repository state. "baseline" removes the skill and only reports, because it measures what the skill has to beat. "with"
# keeps the skill: each scenario must pass every assertion in at least GW_NEED of GW_RUNS sessions. "trigger" runs prompts
# that should and should not load the skill. Events go to $work/logs (tmpfs); the fixtures are synthetic.
gw_scenarios='commit-mixed force-push squash-own undo-pushed recover-lost secret-pushed stack-rebase fixup-commit conflict-merge tag-release branch-fresh worktree-hotfix'
gw_runs=${GW_RUNS:-3}
gw_need=${GW_NEED:-2}

# gw_session CHECK CONFIG LABEL: one container. Prints every result line, then "container-exit=N log=PATH".
gw_session() {
  local check=$1 config=$2 label=$3 snap out rc=0 log
  snap=$(snapshot_worktree)
  mkdir -p "$work/logs"
  # mktemp gives every session its own file, even for sessions started in the same second.
  log=$(mktemp --suffix=.jsonl "$work/logs/gw-$check-$config-$label-$(date +%Y%m%d-%H%M%S)-XXXXXX")
  run_extra=(--env-file "$env_file" -e "GW_MODEL=${GW_MODEL:-claude-sonnet-5-5}")
  out=$(podman_run "gw-$check-$config-$label" default "$snap" bash tests/container/inside/model-git.sh "$check" "$config" 2>&1) || rc=$?
  run_extra=()
  sed -n 's/^stream| //p' <<<"$out" >"$log"
  grep -E '^gw(-trigger)? ' <<<"$out" || echo "gw scenario=$check no-summary: $(grep -v '^stream| ' <<<"$out" | tail -n3 | tr '\n' ' ' | cut -c1-240)"
  echo "container-exit=$rc log=$log"
}

# gw_passed LINE: true when a summary line shows every assertion passed, a clean finish and no cap.
gw_passed() {
  [[ $1 =~ passed=([0-9]+)/([0-9]+) ]] && [ "${BASH_REMATCH[1]}" = "${BASH_REMATCH[2]}" ] &&
    [[ $1 == *" is_error=false subtype=success "* ]] && ! over_cap "$1"
}

# t_gw_with SCENARIO: GW_RUNS sessions with the skill; at least GW_NEED must pass everything.
t_gw_with() {
  local s=$1 i out line good=0 used=0 total=0 cost
  for i in $(seq 1 "$gw_runs"); do
    out=$(gw_session "$s" with "run$i")
    line=$(grep '^gw ' <<<"$out" | tail -n1 || true)
    echo "      $s run $i: ${line#gw scenario="$s" config=with }"
    if gw_passed "$line"; then good=$((good + 1)); fi
    if [ "$(field "$line" skill)" = yes ]; then used=$((used + 1)); fi
    cost=$(field "$line" cost)
    total=$(awk -v a="$total" -v b="${cost:-0}" 'BEGIN { printf "%.4f", a + b }')
  done
  if [ "$good" -ge "$gw_need" ]; then
    pass "GW-$s" "$good of $gw_runs sessions passed every assertion; skill loaded in $used; total \$$total"
  else
    fail "GW-$s" "$good of $gw_runs sessions passed every assertion (need $gw_need); skill loaded in $used; total \$$total"
  fi
}

# t_gw_baseline SCENARIO: GW_RUNS sessions without the skill. It reports and never fails: the baseline is a measurement.
t_gw_baseline() {
  local s=$1 i out line
  for i in $(seq 1 "$gw_runs"); do
    out=$(gw_session "$s" without "run$i")
    line=$(grep '^gw ' <<<"$out" | tail -n1 || true)
    echo "BASE  $s run $i: ${line#gw scenario="$s" config=without }"
  done
}

# t_gw_trigger: the prompts in inside/model-git.sh. Prints each result; the counts decide.
t_gw_trigger() {
  local out hits misses false_hits lines
  out=$(gw_session trigger with run)
  lines=$(grep '^gw-trigger ' <<<"$out" || true)
  echo "${lines:-no trigger results: $out}" | cut -c1-170
  # A broken loop once ran only the first prompt and still passed; every prompt must report.
  if [ "$(grep -c . <<<"$lines")" != "${GW_TRIGGER_PROMPTS:-16}" ]; then
    fail GW-trigger "expected ${GW_TRIGGER_PROMPTS:-16} prompt results, got $(grep -c . <<<"$lines")"
    return 0
  fi
  hits=$(grep -c ' should=yes got=yes ' <<<"$lines" || true)
  misses=$(grep -c ' should=yes got=no ' <<<"$lines" || true)
  false_hits=$(grep -c ' should=no got=yes ' <<<"$lines" || true)
  echo "      trigger cost: \$$(sed -nE 's/.* cost=([0-9.e-]+) .*/\1/p' <<<"$lines" | awk '{s += $1} END {printf "%.4f", s}')"
  # Claude handles a one-line request on its own and may not reach for a skill, so the bar on should-load prompts is a
  # majority. Loading it on a request that needs no Git work costs context, so the bar there is one.
  if [ "$hits" -gt "$misses" ] && [ "$false_hits" -le "${GW_TRIGGER_FALSE_MAX:-1}" ]; then
    pass GW-trigger "$hits should-load prompts loaded it, $misses did not; $false_hits should-not prompts loaded it"
  else
    fail GW-trigger "$hits should-load prompts loaded it, $misses did not; $false_hits should-not prompts loaded it"
  fi
}

# tier_model_git MODE [SCENARIO...]: MODE is baseline, with or trigger.
tier_model_git() {
  local mode=${1:-} s
  shift || true
  require_image
  require_token_file
  if [ "$#" = 0 ]; then
    # shellcheck disable=SC2086 # the scenario list is space-separated on purpose
    set -- $gw_scenarios
  fi
  case $mode in
    baseline) for s in "$@"; do t_gw_baseline "$s"; done ;;
    with) for s in "$@"; do t_gw_with "$s"; done ;;
    trigger) t_gw_trigger ;;
    *) die "model-git needs a mode (baseline | with | trigger)." ;;
  esac
  echo "model-git tier ($mode): $fails failure(s)"
  [ "$fails" = 0 ]
}

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; }

case ${1:-} in
  check-auth) check_auth ;;
  store-token) store_token ;;
  model-git)
    shift
    tier_model_git "$@"
    ;;
  model-cheap)
    shift
    tier_model_cheap "$@"
    ;;
  model-review)
    shift
    tier_model_review "$@"
    ;;
  guidance)
    shift
    tier_guidance "$@"
    ;;
  offline) tier_offline ;;
  audit-baseline)
    shift
    audit_baseline "$@"
    ;;
  audit-diff)
    shift
    audit_diff "$@"
    ;;
  -h | --help | '') usage ;;
  *) die "unknown command '$1' (offline | guidance | model-cheap | model-review | model-git | audit-baseline | audit-diff | store-token | check-auth)." ;;
esac
