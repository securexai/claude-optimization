#!/usr/bin/env bash
# git-workflow-procedures.sh: run inside the test container, offline. Every Git behavior that skills/git-workflow states
# is exercised here, on the Git in the image, including the failure modes it warns about, so a wrong claim fails a test
# instead of reading well. Each test builds its own repositories under a scratch directory; bare repositories stand in
# for remotes.
#
# It runs the whole set twice: with today's default formats, and with the formats Git 3.0 will default to (SHA-256 objects
# and reftable refs), so the procedures are known to survive that change.
#
# Prints one "ok"/"FAIL" line per test and ends with "pass=N fail=M". Exits 1 if anything failed.
# Failure output of a test is printed under its FAIL line. Test bodies run in a subshell under `set -e`, so any step that
# fails fails the test; use `refute` for a command that must fail, because `! cmd` does not trip `set -e`.
set -uo pipefail

# Run from the root of a copy of this repo: two tests execute the skill's own force-push block.
skill_md=$PWD/skills/git-workflow/SKILL.md
[ -f "$skill_md" ] || {
  echo "run from the repository root: $skill_md not found" >&2
  exit 2
}
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Dev GIT_AUTHOR_EMAIL=dev@example.invalid GIT_COMMITTER_NAME=Dev GIT_COMMITTER_EMAIL=dev@example.invalid
export GIT_EDITOR=false GIT_SEQUENCE_EDITOR=false # a procedure that tries to open an editor fails, as it would for an agent
root=$(mktemp -d)
export HOME=$root/home
mkdir -p "$HOME"
git config --global init.defaultBranch main
git config --global advice.detachedHead false

pass=0
fail=0
mode=
T=

refute() { if "$@"; then return 1; fi; }
same() {
  [ "$1" = "$2" ] && return 0
  echo "got '$1', want '$2'"
  return 1
}
reachable() { git merge-base --is-ancestor "$1" "$2"; }

run_test() {
  local name=$1 rc
  shift
  T=$root/$mode/$pass-$fail-$RANDOM
  mkdir -p "$T"
  set +e
  (
    set -e
    "$@"
  ) >"$T.log" 2>&1
  rc=$?
  set -e
  if [ "$rc" = 0 ]; then
    pass=$((pass + 1))
    echo "ok   [$mode] $name"
  else
    fail=$((fail + 1))
    echo "FAIL [$mode] $name"
    sed 's/^/     | /' "$T.log" | tail -n 15
  fi
}

commit_file() { # commit_file FILE TEXT MESSAGE
  printf '%s\n' "$2" >"$1"
  git add -- "$1"
  git commit --quiet -m "$3"
}

# remote_clone NAME: $T/NAME.git (bare) and $T/NAME, a clone holding one pushed commit on main. Leaves the shell in the clone.
remote_clone() {
  git init --quiet --bare -b main "$T/$1.git"
  git clone --quiet "$T/$1.git" "$T/$1" 2>/dev/null
  cd "$T/$1"
  commit_file base.txt base 'base: start'
  git push --quiet -u origin main
  git remote set-head origin main
}

# rewritten_branch NAME: a published branch "topic" that a teammate then advanced and that this clone rewrote locally.
# Sets $theirs, the teammate's commit. The remote-tracking ref is still stale; a test fetches when it wants a background
# fetch to have happened.
rewritten_branch() {
  remote_clone "$1"
  git switch --quiet -c topic
  commit_file mine.txt mine 'topic: mine'
  git push --quiet -u origin topic
  git clone --quiet "$T/$1.git" "$T/$1-mate"
  git -C "$T/$1-mate" switch --quiet topic
  (cd "$T/$1-mate" && commit_file theirs.txt theirs 'topic: theirs' && git push --quiet origin topic)
  theirs=$(git -C "$T/$1-mate" rev-parse HEAD)
  git commit --quiet --amend -m 'topic: mine, reworded'
}

# conflict_repo NAME: main and topic both changed rate.txt. Leaves the shell in the clone, on topic.
conflict_repo() {
  remote_clone "$1"
  commit_file rate.txt 'rate=1' 'rate: start'
  git switch --quiet -c topic
  commit_file rate.txt 'rate=topic' 'rate: topic'
  git switch --quiet main
  commit_file rate.txt 'rate=main' 'rate: main'
  git switch --quiet topic
}

# --- Starting work ---------------------------------------------------------------------------------------------------
t_default_branch() {
  remote_clone a
  git clone --quiet "$T/a.git" "$T/a2"
  same "$(git -C "$T/a2" symbolic-ref --short refs/remotes/origin/HEAD)" origin/main
  git -C "$T/a2" remote set-head origin --delete
  refute git -C "$T/a2" symbolic-ref --quiet refs/remotes/origin/HEAD
  git -C "$T/a2" remote set-head origin --auto
  same "$(git -C "$T/a2" symbolic-ref --short refs/remotes/origin/HEAD)" origin/main
}
t_branch_from_fresh_origin() {
  remote_clone a
  git clone --quiet "$T/a.git" "$T/mate"
  (cd "$T/mate" && commit_file late.txt late 'late: from a teammate' && git push --quiet origin main)
  echo wip >wip.txt
  git fetch --quiet origin
  git switch --quiet -c fresh origin/main --no-track
  reachable "$(git -C "$T/mate" rev-parse HEAD)" HEAD
  test -f wip.txt
  refute git rev-parse --verify --quiet '@{upstream}'
}
t_worktree_isolation() {
  remote_clone a
  commit_file .gitignore .env 'ignore: env'
  echo secret >.env
  echo dirty >>base.txt
  before=$(git status --porcelain)
  git worktree add --quiet "$T/hot" -b hotfix origin/main --no-track
  refute git -C "$T/hot" rev-parse --verify --quiet '@{upstream}'
  same "$(git branch --show-current)" main
  same "$(git status --porcelain)" "$before"
  refute test -e "$T/hot/.env"
  (cd "$T/hot" && commit_file hot.txt hot 'hot: fix')
  same "$(git worktree list | wc -l)" 2
  refute git worktree add --quiet "$T/second" main
  echo stray >"$T/hot/stray.txt"
  refute git worktree remove "$T/hot"
  rm "$T/hot/stray.txt"
  echo edit >>"$T/hot/base.txt"
  refute git worktree remove "$T/hot"
  git -C "$T/hot" restore base.txt
  git worktree lock "$T/hot"
  refute git worktree remove "$T/hot"
  git worktree unlock "$T/hot"
  git worktree remove "$T/hot"
  git rev-parse --verify --quiet hotfix >/dev/null
}

# --- Committing ------------------------------------------------------------------------------------------------------
t_add_all_takes_unignored_env() {
  remote_clone a
  echo 'TOKEN=x' >.env
  git add -A
  same "$(git diff --cached --name-only)" .env
}
t_staging_explicit_paths() {
  remote_clone a
  echo one >one.txt
  echo two >two.txt
  git add -- one.txt
  same "$(git diff --cached --name-only)" one.txt
  same "$(git status --porcelain two.txt)" '?? two.txt'
}
t_partial_staging_without_a_terminal() {
  remote_clone a
  seq 1 30 >n.txt
  git add n.txt
  git commit --quiet -m 'n: start'
  sed -i -e 's/^2$/two/' -e 's/^28$/twenty-eight/' n.txt
  git diff -- n.txt >"$T/all.diff"
  # Keep the first hunk of the patch only: everything before the second "@@" line.
  awk '/^@@/ { n++ } n < 2' "$T/all.diff" >"$T/one.diff"
  git apply --cached --recount "$T/one.diff"
  same "$(git show :n.txt | sed -n 2p)" two
  same "$(git show :n.txt | sed -n 28p)" 28
  same "$(sed -n 28p n.txt)" twenty-eight
}
t_failed_hook_makes_no_commit() {
  remote_clone a
  before=$(git rev-parse HEAD)
  printf '#!/bin/sh\nexit 1\n' >.git/hooks/pre-commit
  chmod +x .git/hooks/pre-commit
  echo x >x.txt
  git add x.txt
  refute git commit --quiet -m 'x: add'
  same "$(git rev-parse HEAD)" "$before"
  same "$(git diff --cached --name-only)" x.txt
  chmod -x .git/hooks/pre-commit
  git commit --quiet -m 'x: add'
  same "$(git rev-parse HEAD~1)" "$before"
}
t_failed_signing_makes_no_commit() {
  remote_clone a
  before=$(git rev-parse HEAD)
  git config gpg.format ssh
  git config user.signingkey "$T/no-such-key.pub"
  git config commit.gpgsign true
  echo x >x.txt
  git add x.txt
  refute git commit --quiet -m 'x: add'
  same "$(git rev-parse HEAD)" "$before"
}
t_ssh_signing_needs_allowed_signers() {
  remote_clone a
  ssh-keygen -q -t ed25519 -N '' -f "$T/key"
  git config gpg.format ssh
  git config user.signingkey "$T/key.pub"
  git config commit.gpgsign true
  commit_file x.txt x 'x: signed'
  # Without an allowed-signers file the signature exists but cannot be verified: %G? is N, not G.
  same "$(git log -1 --format=%G?)" N
  printf 'dev@example.invalid namespaces="git" %s\n' "$(cat "$T/key.pub")" >"$T/allowed"
  git config gpg.ssh.allowedSignersFile "$T/allowed"
  same "$(git log -1 --format=%G?)" G
  git verify-commit HEAD 2>/dev/null
  git tag -s v1.0.0 -m 'Release 1.0.0'
  git verify-tag v1.0.0 2>/dev/null
}
t_config_based_hook() {
  remote_clone a
  git config hook.block.event pre-commit
  git config hook.block.command 'exit 1'
  git hook list pre-commit | grep -q block
  echo x >x.txt
  git add x.txt
  refute git commit --quiet -m 'x: add'
  git config hook.block.enabled false
  git commit --quiet -m 'x: add'
}

# --- Keeping a branch current and editing history ----------------------------------------------------------------------
t_pull_ff_only_refuses_divergence() {
  remote_clone a
  git clone --quiet "$T/a.git" "$T/mate"
  (cd "$T/mate" && commit_file late.txt late 'late: teammate' && git push --quiet origin main)
  commit_file local.txt local 'local: mine'
  before=$(git rev-parse HEAD)
  refute git pull --quiet --ff-only
  same "$(git rev-parse HEAD)" "$before"
}
t_autosquash_runs_without_an_editor() {
  remote_clone a
  git switch --quiet -c topic
  commit_file one.txt one 'one: add'
  commit_file two.txt 'we recieve' 'two: add'
  commit_file three.txt three 'three: add'
  printf 'we receive\n' >two.txt
  git add two.txt
  git commit --quiet --fixup=HEAD~1
  git rebase --quiet --autosquash main
  same "$(git rev-list --count main..HEAD)" 3
  same "$(git show HEAD~1:two.txt)" 'we receive'
  same "$(git log main..HEAD --format=%s | paste -sd,)" 'three: add,two: add,one: add'
}
t_update_refs_moves_a_stack() {
  remote_clone a
  git switch --quiet -c one
  commit_file one.txt 1 'one: first'
  commit_file one.txt 2 'one: second'
  git switch --quiet -c two
  commit_file two.txt 3 'two: on one'
  git switch --quiet main
  commit_file main.txt moved 'main: moved'
  git switch --quiet two
  git rebase --quiet --update-refs main
  reachable main one
  reachable one two
  same "$(git rev-list --count main..one)" 2
  same "$(git rev-list --count main..two)" 3
}
t_update_refs_config_moves_a_stack() {
  remote_clone a
  git switch --quiet -c one
  commit_file one.txt 1 'one: first'
  git switch --quiet -c two
  commit_file two.txt 2 'two: on one'
  git switch --quiet main
  commit_file main.txt moved 'main: moved'
  git switch --quiet two
  git -c rebase.updateRefs=true rebase --quiet main
  reachable main one
  reachable one two
}
t_autosquash_config_needs_the_flag_without_i() {
  remote_clone a
  git switch --quiet -c topic
  commit_file one.txt one 'one: add'
  commit_file two.txt two 'two: add'
  echo fixed >one.txt
  git add one.txt
  git commit --quiet --fixup=HEAD~1
  # The setting covers interactive rebases only; a plain rebase keeps the fixup! commit.
  git -c rebase.autoSquash=true rebase --quiet --force-rebase main
  same "$(git rev-list --count main..HEAD)" 3
  git rebase --quiet --autosquash main
  same "$(git rev-list --count main..HEAD)" 2
}
t_plain_rebase_leaves_a_stack_behind() {
  remote_clone a
  git switch --quiet -c one
  commit_file one.txt 1 'one: first'
  git switch --quiet -c two
  commit_file two.txt 2 'two: on one'
  git switch --quiet main
  commit_file main.txt moved 'main: moved'
  git switch --quiet two
  git rebase --quiet main
  refute reachable one two
}
t_range_diff_checks_a_rewrite() {
  remote_clone a
  git switch --quiet -c topic
  commit_file t.txt t 'topic: change'
  git switch --quiet main
  commit_file m.txt m 'main: moved'
  git switch --quiet topic
  git rebase --quiet main
  git range-diff main ORIG_HEAD HEAD | grep -q 'topic: change'
}
t_rebase_swaps_ours_and_theirs() {
  conflict_repo a
  refute git rebase --quiet main
  git checkout --quiet --ours rate.txt
  same "$(cat rate.txt)" rate=main
  git checkout --quiet --theirs rate.txt
  same "$(cat rate.txt)" rate=topic
  git rebase --abort
}
t_merge_keeps_ours_and_theirs() {
  conflict_repo a
  refute git merge --quiet main
  git checkout --quiet --ours rate.txt
  same "$(cat rate.txt)" rate=topic
  git checkout --quiet --theirs rate.txt
  same "$(cat rate.txt)" rate=main
  git merge --abort
}
t_abort_restores_the_start() {
  conflict_repo a
  before=$(git rev-parse HEAD)
  echo edit >>base.txt
  refute git merge --quiet main
  git merge --abort
  same "$(git rev-parse HEAD)" "$before"
  grep -q edit base.txt
}
t_add_resolved_leaves_other_edits() {
  conflict_repo a
  echo edit >>base.txt
  refute git merge --quiet main
  refute git add --resolved
  echo rate=main >rate.txt
  git add --resolved
  same "$(git diff --cached --name-only)" rate.txt
  same "$(git status --porcelain base.txt)" ' M base.txt'
  git commit --quiet --no-edit
  same "$(git rev-list --parents -n1 HEAD | wc -w)" 3
  same "$(git status --porcelain base.txt)" ' M base.txt'
}
t_diff_check_flags_leftover_markers() {
  conflict_repo a
  refute git merge --quiet main
  git add rate.txt
  refute git diff --cached --check
  git merge --abort
}
t_switch_refuses_to_overwrite_conflicting_edits() {
  remote_clone a
  git clone --quiet "$T/a.git" "$T/mate"
  (cd "$T/mate" && commit_file base.txt theirs 'base: teammate edit' && git push --quiet origin main)
  git fetch --quiet origin
  echo mine >base.txt
  refute git switch --quiet -c topic origin/main --no-track
  same "$(git branch --show-current)" main
  same "$(cat base.txt)" mine
}
t_rerere_replays_a_resolution() {
  conflict_repo a
  # Repository-local, so a failure part-way cannot leave rerere on for the tests after this one.
  git config rerere.enabled true
  refute git merge --quiet main
  echo rate=both >rate.txt
  git add rate.txt
  git commit --quiet --no-edit
  git reset --quiet --hard HEAD~1
  refute git merge --quiet main
  same "$(cat rate.txt)" rate=both
  git merge --abort
}
t_zdiff3_shows_the_base() {
  conflict_repo a
  refute git -c merge.conflictStyle=zdiff3 merge --quiet main
  grep -q '^||||||| ' rate.txt
  grep -q '^rate=1$' rate.txt
  git merge --abort
}

# --- Pushing ---------------------------------------------------------------------------------------------------------
t_push_u_head_uses_the_branch_name() {
  remote_clone a
  git switch --quiet -c topic
  commit_file t.txt t 'topic: add'
  git push --quiet -u origin HEAD
  git -C "$T/a.git" rev-parse --verify --quiet refs/heads/topic >/dev/null
  same "$(git rev-parse --abbrev-ref '@{upstream}')" origin/topic
}
t_bare_lease_loses_work_after_a_fetch() {
  rewritten_branch a
  git fetch --quiet origin
  git push --quiet --force-with-lease origin topic
  refute git -C "$T/a.git" merge-base --is-ancestor "$theirs" refs/heads/topic
}
t_if_includes_keeps_work_after_a_fetch() {
  rewritten_branch a
  git fetch --quiet origin
  refute git push --quiet --force-with-lease --force-if-includes origin topic
  git -C "$T/a.git" merge-base --is-ancestor "$theirs" refs/heads/topic
}
t_lease_alone_works_only_without_a_fetch() {
  rewritten_branch a
  refute git push --quiet --force-with-lease origin topic
  git -C "$T/a.git" merge-base --is-ancestor "$theirs" refs/heads/topic
}
t_explicit_lease_survives_a_fetch() {
  rewritten_branch a
  seen=$(git rev-parse 'HEAD@{1}')
  git fetch --quiet origin
  refute git push --quiet "--force-with-lease=topic:$seen" origin topic
  git -C "$T/a.git" merge-base --is-ancestor "$theirs" refs/heads/topic
}
t_unseen_commits_are_visible_before_pushing() {
  rewritten_branch a
  git fetch --quiet origin
  same "$(git log --format=%s 'HEAD..@{upstream}' | grep -c 'topic: theirs')" 1
}
t_usual_rebase_then_forced_push_goes_through() {
  remote_clone a
  git switch --quiet -c topic
  commit_file mine.txt mine 'topic: mine'
  git push --quiet -u origin topic
  git switch --quiet main
  commit_file m.txt m 'main: moved'
  git push --quiet origin main
  git switch --quiet topic
  git fetch --quiet origin
  git rebase --quiet origin/main
  git push --quiet --force-with-lease --force-if-includes origin topic
  same "$(git -C "$T/a.git" rev-parse refs/heads/topic)" "$(git rev-parse HEAD)"
}
t_forced_push_goes_through_once_work_is_integrated() {
  rewritten_branch a
  git fetch --quiet origin
  git rebase --quiet origin/topic
  git commit --quiet --amend -m 'topic: theirs, reworded'
  git push --quiet --force-with-lease --force-if-includes origin topic
  same "$(git -C "$T/a.git" rev-parse refs/heads/topic)" "$(git rev-parse HEAD)"
}
t_lease_pinned_to_the_fetched_tip_loses_work() {
  rewritten_branch a
  git fetch --quiet origin
  # Pinning the lease to what was just fetched authorizes overwriting exactly that.
  git push --quiet "--force-with-lease=topic:$(git rev-parse '@{upstream}')" origin topic
  refute git -C "$T/a.git" merge-base --is-ancestor "$theirs" refs/heads/topic
}
t_right_only_lists_only_the_work_a_push_would_drop() {
  rewritten_branch a
  git fetch --quiet origin
  # The reworded commit has the same change as the published one, so only the teammate's commit is listed.
  same "$(git log --format=%s --cherry-pick --right-only 'HEAD...@{upstream}')" 'topic: theirs'
}
# would_drop: the subjects the skill's check lists for the branch "topic" against the tip in $checked. It runs the
# `rewritten=` and `lost=` lines of the skill's own block (skill_block below), so these tests follow the skill's text.
would_drop() {
  # shellcheck disable=SC2034 # rewritten is assigned and read by the skill's lines that the eval below runs
  local lines rewritten lost
  lines=$(skill_block | grep -E '^[[:space:]]*(rewritten|lost)=' | sed -E 's/[[:space:]]*&&$//')
  [ "$(grep -c . <<<"$lines")" = 2 ] || {
    echo "the skill's force-push block no longer has one rewritten= and one lost= line"
    return 1
  }
  eval "$lines"
  # shellcheck disable=SC2154 # lost is assigned by the eval above
  if [ -n "$lost" ]; then cut -d' ' -f3- <<<"$lost"; fi
}
# squashed_own_branch NAME: "topic" pushed with two commits of this clone, then squashed into one with another change, as a
# rewrite with conflict resolution or an amend would. Their patches no longer match anything in the new commit.
squashed_own_branch() {
  remote_clone "$1"
  git switch --quiet -c topic
  commit_file r.txt 'header' 'r: add the header'
  commit_file r.txt 'header fixed' 'r: fix the header'
  git push --quiet -u origin topic
  git reset --quiet --soft HEAD~2
  printf 'header fixed\nand more\n' >r.txt
  git add r.txt
  git commit --quiet -m 'r: add the header'
}
t_check_skips_own_rewritten_commits() {
  squashed_own_branch a
  git fetch --quiet origin
  checked=$(git rev-parse origin/topic)
  # Without the reflog exclusion both of this clone's own pushed commits look like work a push would drop.
  same "$(git log --format=%s --cherry-pick --right-only "topic...$checked" | wc -l)" 2
  same "$(would_drop)" ''
  git push --quiet "--force-with-lease=topic:$checked" origin topic
  same "$(git -C "$T/a.git" rev-list --count main..topic)" 1
}
t_check_lists_only_a_teammate_beside_own_rewrites() {
  squashed_own_branch a
  git clone --quiet "$T/a.git" "$T/mate"
  git -C "$T/mate" switch --quiet topic
  (cd "$T/mate" && commit_file eu.txt eu 'r: add the EU rates' && git push --quiet origin topic)
  git fetch --quiet origin
  checked=$(git rev-parse origin/topic)
  same "$(would_drop)" 'r: add the EU rates'
}
t_pinned_lease_refuses_what_arrived_after_the_check() {
  rewritten_branch a
  git fetch --quiet origin
  git cherry-pick "$theirs" >/dev/null
  checked=$(git rev-parse origin/topic)
  same "$(would_drop)" ''
  (cd "$T/a-mate" && commit_file late.txt late 'topic: after the check' && git push --quiet origin topic)
  late=$(git -C "$T/a-mate" rev-parse HEAD)
  git fetch --quiet origin
  refute git push --quiet "--force-with-lease=topic:$checked" origin topic
  git -C "$T/a.git" merge-base --is-ancestor "$late" refs/heads/topic
}
t_integrated_by_cherry_pick_then_pinned_lease() {
  rewritten_branch a
  git fetch --quiet origin
  checked=$(git rev-parse origin/topic)
  same "$(would_drop)" 'topic: theirs'
  git cherry-pick "$theirs" >/dev/null
  same "$(would_drop)" ''
  # The fetched tip is not in this branch's reflog, so --force-if-includes refuses; the lease pinned to the checked tip goes.
  refute git push --quiet --force-with-lease --force-if-includes origin topic
  git push --quiet "--force-with-lease=topic:$checked" origin topic
  git -C "$T/a.git" cat-file -e refs/heads/topic:theirs.txt
  git -C "$T/a.git" cat-file -e refs/heads/topic:mine.txt
}
t_usual_rebase_then_pinned_push_goes_through() {
  remote_clone a
  git switch --quiet -c topic
  commit_file mine.txt mine 'topic: mine'
  git push --quiet -u origin topic
  git switch --quiet main
  commit_file m.txt m 'main: moved'
  git push --quiet origin main
  git switch --quiet topic
  git fetch --quiet origin
  git rebase --quiet origin/main
  checked=$(git rev-parse origin/topic)
  same "$(would_drop)" ''
  git push --quiet "--force-with-lease=topic:$checked" origin topic
  same "$(git -C "$T/a.git" rev-parse refs/heads/topic)" "$(git rev-parse HEAD)"
}
# skill_block: the force-push command exactly as skills/git-workflow/SKILL.md shows it, so this suite tests the skill's
# own text: the first bash block in section 5, and nothing from a later section.
skill_block() {
  awk '/^## / { if (s) exit; if (/^## 5\./) s = 1; next } s && /^```bash$/ { b = 1; next } b && /^```$/ { exit } b { print }' "$skill_md"
}
t_skill_block_stops_before_deleting_a_teammate_commit() {
  rewritten_branch a
  block=$(skill_block)
  grep -q 'force-with-lease' <<<"$block"
  # A refusal must not look like success to whatever reads the exit status.
  refute bash -c "$block" >"$T/out" 2>&1
  grep -q '^Not pushed' "$T/out"
  grep -q 'topic: theirs' "$T/out"
  git -C "$T/a.git" merge-base --is-ancestor "$theirs" refs/heads/topic
}
t_skill_block_pushes_a_squashed_own_branch() {
  squashed_own_branch a
  bash -c "$(skill_block)" >"$T/out" 2>&1
  refute grep -q '^Not pushed' "$T/out"
  same "$(git -C "$T/a.git" rev-parse refs/heads/topic)" "$(git rev-parse HEAD)"
}
t_tracking_origin_main_points_upstream_at_main() {
  remote_clone a
  git switch --quiet -c topic origin/main
  same "$(git rev-parse --abbrev-ref '@{upstream}')" origin/main
  commit_file t.txt t 'topic: add'
  refute git push --quiet
  git push --quiet -u origin HEAD
  same "$(git rev-parse --abbrev-ref '@{upstream}')" origin/topic
}
t_use_force_if_includes_config() {
  rewritten_branch a
  git config push.useForceIfIncludes true
  git fetch --quiet origin
  refute git push --quiet --force-with-lease origin topic
}
t_auto_setup_remote_config() {
  remote_clone a
  git config push.autoSetupRemote true
  git switch --quiet -c topic
  commit_file t.txt t 'topic: add'
  git push --quiet
  same "$(git rev-parse --abbrev-ref '@{upstream}')" origin/topic
}
t_prune_drops_a_stale_tracking_ref() {
  remote_clone a
  git push --quiet origin main:refs/heads/gone
  git fetch --quiet origin
  git -C "$T/a.git" update-ref -d refs/heads/gone
  git -c fetch.prune=true fetch --quiet origin
  refute git rev-parse --verify --quiet refs/remotes/origin/gone
}

# --- Undoing ---------------------------------------------------------------------------------------------------------
t_revert_keeps_history() {
  remote_clone a
  commit_file r.txt up 'r: up'
  commit_file r.txt down 'r: down'
  bad=$(git rev-parse HEAD)
  commit_file later.txt later 'later: work'
  later=$(git rev-parse HEAD)
  git revert --quiet --no-edit "$bad"
  same "$(cat r.txt)" up
  test -f later.txt
  reachable "$later" HEAD
}
t_revert_a_merge_then_revert_the_revert() {
  remote_clone a
  git switch --quiet -c f
  commit_file f.txt f 'f: add'
  git switch --quiet main
  git merge --quiet --no-ff -m 'merge f' f
  refute git revert --no-edit HEAD
  git revert --abort 2>/dev/null || true
  git revert --quiet --no-edit -m 1 HEAD
  refute test -e f.txt
  revert=$(git rev-parse HEAD)
  # A newer commit on the branch: merging again brings only that commit, not the reverted one.
  git switch --quiet f
  commit_file g.txt g 'f: later work'
  git switch --quiet main
  git merge --quiet --no-edit f
  test -f g.txt
  refute test -e f.txt
  git revert --quiet --no-edit "$revert"
  test -f f.txt
  test -f g.txt
}
t_reset_soft_keeps_the_work_staged() {
  remote_clone a
  before=$(git rev-parse HEAD)
  commit_file x.txt x 'x: add'
  git reset --quiet --soft HEAD~1
  same "$(git rev-parse HEAD)" "$before"
  same "$(git diff --cached --name-only)" x.txt
  git restore --staged x.txt
  same "$(git status --porcelain x.txt)" '?? x.txt'
}
t_reflog_brings_back_lost_commits() {
  remote_clone a
  git switch --quiet -c topic
  commit_file two.txt 2 'two: add'
  two=$(git rev-parse HEAD)
  commit_file three.txt 3 'three: add'
  three=$(git rev-parse HEAD)
  git reset --quiet --hard HEAD~2
  echo edit >>base.txt
  same "$(git rev-parse 'HEAD@{1}')" "$three"
  git merge --quiet --ff-only 'HEAD@{1}'
  reachable "$two" HEAD
  reachable "$three" HEAD
  grep -q edit base.txt
}
t_reflog_branch_rescue_touches_nothing() {
  remote_clone a
  git switch --quiet -c topic
  commit_file two.txt 2 'two: add'
  two=$(git rev-parse HEAD)
  git reset --quiet --hard HEAD~1
  echo edit >>base.txt
  before=$(git status --porcelain)
  git branch rescue "$two"
  same "$(git status --porcelain)" "$before"
  same "$(git rev-parse rescue)" "$two"
}
t_fsck_finds_a_commit_after_the_reflog_expired() {
  remote_clone a
  commit_file gone.txt gone 'gone: soon unreachable'
  gone=$(git rev-parse HEAD)
  git reset --quiet --hard HEAD~1
  git reflog expire --expire=now --expire-unreachable=now --all
  refute grep -q "$gone" <<<"$(git reflog)"
  git fsck --lost-found 2>/dev/null | grep -q "dangling commit $gone"
}
t_fsck_finds_lost_staged_content() {
  remote_clone a
  echo 'staged then lost' >lost.txt
  git add lost.txt
  blob=$(git rev-parse :lost.txt)
  git reset --quiet --hard
  git fsck --lost-found 2>/dev/null | grep -q "dangling blob $blob"
}
# GIT_EDITOR=false is exported for every test, so a command that opens an editor fails.
t_rebase_continue_opens_an_editor() {
  conflict_repo a
  refute git rebase --quiet main
  # A resolution equal to main's side would leave an empty commit, which --continue drops without an editor.
  echo rate=both >rate.txt
  git add rate.txt
  refute git rebase --continue
  refute git -c core.editor=true rebase --continue
  GIT_EDITOR=true git rebase --continue
  same "$(git log -1 --format=%s)" 'rate: topic'
}
t_cherry_pick_continue_needs_no_editor() {
  conflict_repo a
  git switch --quiet main
  refute git cherry-pick topic
  echo rate=picked >rate.txt
  git add rate.txt
  git cherry-pick --continue
  same "$(git log -1 --format=%s)" 'rate: topic'
}
t_merge_finishes_with_commit_no_edit() {
  conflict_repo a
  refute git merge --quiet main
  echo rate=merged >rate.txt
  git add rate.txt
  refute git merge --continue
  git commit --quiet --no-edit
  same "$(git rev-list --parents -n1 HEAD | wc -w)" 3
}
t_reset_keep_moves_a_commit_off_main() {
  remote_clone a
  tip=$(git rev-parse origin/main)
  commit_file oops.txt oops 'oops: on main by mistake'
  oops=$(git rev-parse HEAD)
  echo edit >>base.txt
  git branch topic
  git reset --quiet --keep origin/main
  same "$(git rev-parse HEAD)" "$tip"
  same "$(git rev-parse topic)" "$oops"
  grep -q edit base.txt
}
t_reset_keep_refuses_to_lose_edits() {
  remote_clone a
  commit_file oops.txt oops 'oops: on main by mistake'
  echo edit >>oops.txt
  head=$(git rev-parse HEAD)
  refute git reset --quiet --keep origin/main
  same "$(git rev-parse HEAD)" "$head"
  grep -q edit oops.txt
}
t_clean_dry_run_deletes_nothing() {
  remote_clone a
  echo x >x.txt
  git clean -n | grep -q x.txt
  test -f x.txt
}

# --- Tidying branches ------------------------------------------------------------------------------------------------
t_squash_merged_branch_does_not_look_merged() {
  remote_clone a
  git switch --quiet -c topic
  commit_file t.txt t 'topic: add'
  git switch --quiet main
  git merge --quiet --squash topic >/dev/null
  git commit --quiet -m 'topic: add (squashed)'
  refute grep -qx topic <<<"$(git branch --merged main --format='%(refname:short)')"
  refute git branch -d topic
  git rev-parse --verify --quiet topic >/dev/null
}
t_delete_merged_keeps_pushed_work_and_drops_landed_work() {
  remote_clone a
  # A branch that tracks its own pushed copy is never selected, merged or not.
  git switch --quiet -c pushed
  commit_file p.txt p 'pushed: not merged into main'
  git push --quiet -u origin pushed
  # A branch that tracks origin/main is selected once its work is on origin/main.
  git switch --quiet -c landed --track origin/main
  commit_file l.txt l 'landed: merged into main'
  git push --quiet origin landed:main
  git switch --quiet main
  git fetch --quiet origin
  same "$(git branch --delete-merged 'origin/*' --dry-run 2>&1 | grep -c landed)" 1
  refute grep -q pushed <<<"$(git branch --delete-merged 'origin/*' --dry-run 2>&1)"
  git rev-parse --verify --quiet landed >/dev/null
  git branch --delete-merged 'origin/*' >/dev/null 2>&1
  refute git rev-parse --verify --quiet refs/heads/landed
  git rev-parse --verify --quiet refs/heads/pushed >/dev/null
}

# --- Releases --------------------------------------------------------------------------------------------------------
t_annotated_and_lightweight_tags() {
  remote_clone a
  git tag -a v1.0.0 -m 'Release 1.0.0'
  same "$(git cat-file -t v1.0.0)" tag
  same "$(git describe)" v1.0.0
  commit_file x.txt x 'x: add'
  git tag v1.1.0
  same "$(git cat-file -t v1.1.0)" commit
  same "$(git describe --abbrev=0)" v1.0.0
  refute git tag -a v1.0.0 -m 'again'
  git push --quiet origin v1.0.0
  git -C "$T/a.git" rev-parse --verify --quiet refs/tags/v1.0.0 >/dev/null
  refute git -C "$T/a.git" rev-parse --verify --quiet refs/tags/v1.1.0
}
t_cherry_pick_x_records_the_source() {
  remote_clone a
  git tag v1.0.0
  commit_file fix.txt fix 'fix: the bug'
  fix=$(git rev-parse HEAD)
  git switch --quiet -c release/1.0 v1.0.0
  git cherry-pick -x "$fix" >/dev/null
  git log -1 --format=%b | grep -qF "(cherry picked from commit $fix)"
}

# --- Bisect ----------------------------------------------------------------------------------------------------------
bisect_repo() {
  remote_clone a
  first=$(git rev-parse HEAD)
  for i in 1 2 3 4 5 6 7 8; do
    if [ "$i" -ge 5 ]; then printf 'broken\n' >state.txt; else printf 'fine\n' >state.txt; fi
    git add state.txt
    git commit --quiet --allow-empty -m "step $i"
  done
  culprit=$(git rev-list --reverse "$first..HEAD" | sed -n 5p)
  tip=$(git rev-parse HEAD)
}
t_bisect_run_finds_the_culprit() {
  bisect_repo
  git bisect start HEAD "$first" >/dev/null
  git bisect run sh -c '! grep -q broken state.txt' >"$T/out" 2>&1
  grep -Eq "first 'bad' commit|first bad commit" "$T/out"
  grep -q "$culprit" "$T/out"
  same "$(git rev-parse refs/bisect/bad)" "$culprit"
  git bisect reset >/dev/null 2>&1
  same "$(git rev-parse HEAD)" "$tip"
}
t_bisect_run_exit_125_skips() {
  bisect_repo
  git bisect start HEAD "$first" >/dev/null
  skip=$(git rev-list --reverse "$first..HEAD" | sed -n 4p)
  git bisect run sh -c "[ \"\$(git rev-parse HEAD)\" != $skip ] || exit 125; ! grep -q broken state.txt" >"$T/out" 2>&1 || true
  grep -Eq "first bad commit|There are only 'skip'ped commits left" "$T/out"
  git bisect log | grep -q "skip: \[$skip\]\|skip $skip"
  git bisect reset >/dev/null 2>&1
}
t_bisect_run_other_codes_abort() {
  bisect_repo
  git bisect start HEAD "$first" >/dev/null
  refute git bisect run sh -c 'exit 200' >"$T/out" 2>&1
  git bisect reset >/dev/null 2>&1
}
t_bisect_run_reset_when_found() {
  bisect_repo
  git bisect start HEAD "$first" >/dev/null
  git bisect run --reset-when-found sh -c '! grep -q broken state.txt' >"$T/out" 2>&1
  grep -q "$culprit" "$T/out"
  same "$(git rev-parse HEAD)" "$tip"
  refute git bisect log
}

# --- Working with repositories you did not create ------------------------------------------------------------------
t_copied_repo_config_runs_code_on_status() {
  remote_clone a
  printf '#!/bin/sh\necho ran >"%s"\nexit 1\n' "$T/ran" >"$T/fsmonitor"
  chmod +x "$T/fsmonitor"
  git config core.fsmonitor "$T/fsmonitor"
  git status >/dev/null 2>&1 || true
  test -f "$T/ran"
}
t_clone_carries_no_hooks_or_config() {
  remote_clone a
  git config core.fsmonitor /bin/false
  printf '#!/bin/sh\nexit 1\n' >.git/hooks/pre-commit
  chmod +x .git/hooks/pre-commit
  git clone --quiet "$T/a" "$T/a2"
  refute test -e "$T/a2/.git/hooks/pre-commit"
  refute git -C "$T/a2" config core.fsmonitor
}
t_explicit_bare_setting_refuses_embedded_repos() {
  git init --quiet --bare "$T/embedded"
  cd "$T/embedded"
  git rev-parse --git-dir >/dev/null
  refute git -c safe.bareRepository=explicit rev-parse --git-dir
  git -c safe.bareRepository=explicit --git-dir="$T/embedded" rev-parse --git-dir >/dev/null
}
t_scripts_ask_for_the_object_format() {
  remote_clone a
  case $mode in
    current)
      same "$(git rev-parse --show-object-format)" sha1
      same "$(git rev-parse --show-ref-format)" files
      same "$(git rev-parse HEAD | wc -c)" 41
      ;;
    git3)
      same "$(git rev-parse --show-object-format)" sha256
      same "$(git rev-parse --show-ref-format)" reftable
      same "$(git rev-parse HEAD | wc -c)" 65
      # Refs live in the reftable, not in files a script could read.
      refute test -e .git/refs/heads/main
      git for-each-ref --format='%(refname)' refs/heads | grep -qx refs/heads/main
      ;;
  esac
}

run_all() {
  run_test 'default branch from origin/HEAD, repairable with set-head --auto' t_default_branch
  run_test 'a branch from fresh origin/main starts at the teammate tip, keeps edits, tracks nothing' t_branch_from_fresh_origin
  run_test 'worktree: main checkout untouched, ignored files absent, one branch per worktree, remove refuses changes and locks' t_worktree_isolation
  run_test 'git add -A takes an unignored .env' t_add_all_takes_unignored_env
  run_test 'explicit paths stage only those paths' t_staging_explicit_paths
  run_test 'git apply --cached stages one hunk without a terminal' t_partial_staging_without_a_terminal
  run_test 'a failed hook leaves no commit and keeps the index' t_failed_hook_makes_no_commit
  run_test 'a failed signature leaves no commit' t_failed_signing_makes_no_commit
  run_test 'SSH signatures read N until gpg.ssh.allowedSignersFile is set, then G' t_ssh_signing_needs_allowed_signers
  run_test 'config-based hook runs and can be turned off' t_config_based_hook
  run_test 'pull --ff-only refuses a diverged branch' t_pull_ff_only_refuses_divergence
  run_test 'rebase --autosquash runs without -i or an editor' t_autosquash_runs_without_an_editor
  run_test 'rebase --update-refs moves every branch of a stack' t_update_refs_moves_a_stack
  run_test 'a plain rebase leaves the lower branch of a stack behind' t_plain_rebase_leaves_a_stack_behind
  run_test 'range-diff compares the branch before and after a rewrite' t_range_diff_checks_a_rewrite
  run_test 'during a rebase --ours is the base and --theirs is your commit' t_rebase_swaps_ours_and_theirs
  run_test 'during a merge --ours is your branch and --theirs is the other one' t_merge_keeps_ours_and_theirs
  run_test 'merge --abort restores the start and keeps unrelated edits' t_abort_restores_the_start
  run_test 'add --resolved refuses markers and leaves unrelated edits unstaged' t_add_resolved_leaves_other_edits
  run_test 'rerere replays a recorded resolution' t_rerere_replays_a_resolution
  run_test 'zdiff3 conflict markers show the base' t_zdiff3_shows_the_base
  run_test 'push -u origin HEAD publishes under the branch name' t_push_u_head_uses_the_branch_name
  run_test 'a bare --force-with-lease loses a teammate commit after a fetch' t_bare_lease_loses_work_after_a_fetch
  run_test 'adding --force-if-includes refuses that push and keeps the commit' t_if_includes_keeps_work_after_a_fetch
  run_test 'a bare --force-with-lease refuses only while the tracking ref is stale' t_lease_alone_works_only_without_a_fetch
  run_test 'an explicit --force-with-lease=ref:sha refuses even after a fetch' t_explicit_lease_survives_a_fetch
  run_test 'git log HEAD..@{upstream} shows commits you would overwrite' t_unseen_commits_are_visible_before_pushing
  run_test 'the usual fetch, rebase, forced push goes through with both flags' t_usual_rebase_then_forced_push_goes_through
  run_test 'a forced push goes through once the fetched tip is integrated' t_forced_push_goes_through_once_work_is_integrated
  run_test 'push.useForceIfIncludes makes a bare lease refuse' t_use_force_if_includes_config
  run_test 'push.autoSetupRemote publishes a new branch on plain push' t_auto_setup_remote_config
  run_test 'fetch.prune drops a stale remote-tracking ref' t_prune_drops_a_stale_tracking_ref
  run_test 'git revert undoes a commit and keeps later work and history' t_revert_keeps_history
  run_test 'a merge needs revert -m 1; re-merging brings only newer commits until the revert is reverted' t_revert_a_merge_then_revert_the_revert
  run_test 'reset --soft keeps the work staged; restore --staged unstages it' t_reset_soft_keeps_the_work_staged
  run_test 'merge --ff-only HEAD@{1} restores lost commits and keeps edits' t_reflog_brings_back_lost_commits
  run_test 'git branch rescue SHA recovers a commit and changes nothing else' t_reflog_branch_rescue_touches_nothing
  run_test 'branch then reset --keep moves a commit off main and keeps edits' t_reset_keep_moves_a_commit_off_main
  run_test 'reset --keep refuses when it would lose edits' t_reset_keep_refuses_to_lose_edits
  run_test 'git clean -n deletes nothing' t_clean_dry_run_deletes_nothing
  run_test 'a squash-merged branch is not reported as merged and branch -d refuses it' t_squash_merged_branch_does_not_look_merged
  run_test 'branch --delete-merged keeps a branch on its own pushed copy and drops one landed on origin/main' t_delete_merged_keeps_pushed_work_and_drops_landed_work
  run_test 'annotated tags describe, lightweight tags do not, an existing tag refuses, push names one' t_annotated_and_lightweight_tags
  run_test 'cherry-pick -x records the source commit' t_cherry_pick_x_records_the_source
  run_test 'bisect run finds the first bad commit' t_bisect_run_finds_the_culprit
  run_test 'bisect run treats exit 125 as skip' t_bisect_run_exit_125_skips
  run_test 'bisect run aborts on an exit code above 127' t_bisect_run_other_codes_abort
  run_test 'bisect run --reset-when-found returns to the start' t_bisect_run_reset_when_found
  run_test 'a copied .git/config can run code on git status' t_copied_repo_config_runs_code_on_status
  run_test 'a clone carries neither hooks nor local config' t_clone_carries_no_hooks_or_config
  run_test 'safe.bareRepository=explicit refuses an embedded bare repository' t_explicit_bare_setting_refuses_embedded_repos
  run_test 'git reports the object and ref format, and hash length follows it' t_scripts_ask_for_the_object_format
  run_test 'a lease pinned to the tip just fetched loses a teammate commit' t_lease_pinned_to_the_fetched_tip_loses_work
  run_test '--cherry-pick --right-only leaves out a reworded own commit with the same change and lists the teammate commit' t_right_only_lists_only_the_work_a_push_would_drop
  run_test 'after cherry-picking missing work the check is empty, if-includes refuses, a lease pinned to the checked tip goes through' t_integrated_by_cherry_pick_then_pinned_lease
  run_test 'the check leaves out own commits rewritten with other content, and the pinned push goes through' t_check_skips_own_rewritten_commits
  run_test 'the check lists a teammate commit and nothing of a squashed own history' t_check_lists_only_a_teammate_beside_own_rewrites
  run_test 'a lease pinned to the checked tip refuses a commit that arrived after the check' t_pinned_lease_refuses_what_arrived_after_the_check
  run_test 'the usual fetch, rebase, check and pinned push goes through' t_usual_rebase_then_pinned_push_goes_through
  run_test 'a branch started from origin/main tracks it: plain push refuses, push -u origin HEAD fixes the upstream' t_tracking_origin_main_points_upstream_at_main
  run_test "the skill's own force-push block stops and names a teammate commit, pushing nothing" t_skill_block_stops_before_deleting_a_teammate_commit
  run_test "the skill's own force-push block pushes a squashed own branch" t_skill_block_pushes_a_squashed_own_branch
  run_test 'rebase.updateRefs=true moves a stack without the flag' t_update_refs_config_moves_a_stack
  run_test 'rebase.autoSquash=true does not squash in a plain rebase; --autosquash does' t_autosquash_config_needs_the_flag_without_i
  run_test 'diff --cached --check flags leftover conflict markers' t_diff_check_flags_leftover_markers
  run_test 'switch -c from origin/main refuses rather than overwrite conflicting edits' t_switch_refuses_to_overwrite_conflicting_edits
  run_test 'fsck --lost-found finds a commit after its reflog entry expired' t_fsck_finds_a_commit_after_the_reflog_expired
  run_test 'fsck --lost-found finds content that was staged and then reset away' t_fsck_finds_lost_staged_content
  run_test 'rebase --continue opens an editor; GIT_EDITOR=true avoids it and -c core.editor does not' t_rebase_continue_opens_an_editor
  run_test 'cherry-pick --continue opens no editor' t_cherry_pick_continue_needs_no_editor
  run_test 'merge --continue opens an editor; commit --no-edit finishes the merge' t_merge_finishes_with_commit_no_edit
}

mode=current
unset GIT_DEFAULT_HASH GIT_DEFAULT_REF_FORMAT
run_all
mode=git3
export GIT_DEFAULT_HASH=sha256 GIT_DEFAULT_REF_FORMAT=reftable
run_all

echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
