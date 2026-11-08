#!/usr/bin/env bash
# test-bash-guard.sh [hook]: feeds PreToolUse JSON to bash-guard.sh and checks each decision.
# Expected values: ask, deny, or - (no output, exit 0). Exits 1 if any case fails.
set -uo pipefail
hook=${1:-$(dirname "$0")/bash-guard.sh}
pass=0 fail=0

check() { # check <expected> <command> [tool]
  local want=$1 cmd=$2 tool=${3:-Bash} out rc got
  out=$(jq -cn --arg c "$cmd" --arg t "$tool" \
    '{hook_event_name: "PreToolUse", tool_name: $t, tool_input: {command: $c}, permission_mode: "auto"}' | "$hook")
  rc=$?
  got=$(jq -r '.hookSpecificOutput.permissionDecision // "?"' <<<"${out:-null}" 2>/dev/null)
  [ -z "$out" ] && got=-
  if [ "$rc" -eq 0 ] && [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); printf 'FAIL want=%s got=%s rc=%s: %s\n' "$want" "$got" "$rc" "$cmd"
  fi
}

# --- ask: pushes, including the forms found in the transcript audit ---
check ask 'git push origin main'
check ask 'git push -u origin model-discovery 2>&1 && git branch -vv | cat'
check ask 'git -C ~/code/repos/mikrotik push -u origin feat/x'
check ask 'git -c http.extraHeader=x push'
check ask "toolbox run --container dev-infra-hermes bash -c 'cd ~/code/repos/hermes-fedora-host && git push origin codex/hermes-production-bundle 2>&1 | tail -1'"
check ask "toolbox run --container dev-infra-mikrotik bash -c 'cd ~/code/repos/mikrotik && GIT_SSH_COMMAND=\"ssh -o BatchMode=yes\" git push -u origin feat/wireguard'"
check ask 'timeout 540 git push origin b > ~/.cache/push.log 2>&1'
check ask 'git push --force-with-lease origin b'
check ask '/usr/bin/git push'
check ask $'cd repo\ngit push'
check ask $'git \\\n  push origin main'
check ask 'git push --dry-run origin main; git push origin main'
check ask 'echo "git push is how you publish"'   # known false positive: text mentioning a push
# --- ask: pushes as an argv list or through an inline alias ---
check ask 'python3 -c '"'"'import subprocess; subprocess.run(["git", "push", "origin", "main"])'"'"
check ask "python3 -c \"import subprocess; subprocess.check_call(['git', 'push', '-u', 'origin', 'b'], cwd=repo)\""
check ask 'python3 -c "import subprocess; subprocess.run([\"/usr/bin/git\", \"-C\", str(repo), \"--no-pager\", \"push\"])"'
check ask $'python3 - <<\'EOF\'\nimport subprocess\nsubprocess.run(\n    [\n        "git",\n        "-C",\n        f"{home}/repo",\n        "push",\n    ],\n    check=True,\n)\nEOF'
check ask 'node -e '"'"'require("child_process").execFileSync("git", ["push", "origin", "main"])'"'"
check ask 'python3 -c '"'"'import subprocess as s; s.run(["git", "push", "--dry-run"]); s.run(["git", "push"])'"'"
check ask 'git -c alias.p=push p origin main'
check ask "git -c alias.p='push --force-with-lease' p origin b"
check ask "git -c 'ALIAS.P=-p push' P origin main"
check ask "toolbox run --container dev-infra-mikrotik bash -c 'git -C ~/code/repos/mikrotik -c \"alias.p=push\" p -u origin feat/x'"
check ask "git -c alias.l='log --oneline' -c alias.p=push p"
check ask 'bash -c "git -c alias.p=\"push\" p"'
check ask "git -c user.name='A B' push"
check ask 'git -c alias.a=push -c alias.b=a b'
check ask 'git -c alias.p=push status'   # known false positive: an inline push alias asks even unused, which catches chains
check ask "git -c alias.p='!git push' p"
check ask 'git -c alias.p=push p --dry-run; git -c alias.p=push p'
check ask 'python3 -c '"'"'import subprocess; subprocess.run(["git", "-c", "alias.p=push", "p", "origin", "main"])'"'"
# --- ask: gh writes ---
check ask 'gh pr create --title x --body y'
check ask 'gh pr merge 37 --repo securexai/mikrotik --merge --match-head-commit "$(git rev-parse d9dc5ea)"'
check ask 'gh pr edit 37 --repo securexai/mikrotik --body-file /tmp/body.md'
check ask 'gh issue comment 5 --body hi'
check ask 'gh release create v1.0.0'
check ask 'gh repo edit --visibility public'
check ask 'gh api repos/securexai/x/issues -f title=hi'
check ask 'gh api -X DELETE repos/securexai/x'
check ask 'gh api --method PATCH repos/securexai/x -F private=true'
check ask "gh api graphql -f query='mutation { addStar(input: {starrableId: \"x\"}) { clientMutationId } }'"
check ask 'tail -f build.log & git push' Monitor

# --- deny: hook bypasses ---
check deny 'git commit --no-verify -m x'
check deny 'git push --no-verify origin main'
check deny 'git commit -nm "fix"'
check deny 'git commit -m "x" -n'
check deny 'git commit -an -m x'
check deny "toolbox run --container dev-infra-hermes bash -c 'git commit -m \"x\" -n'"
check deny 'git -c core.hooksPath=/dev/null commit -m x'
check deny 'git config core.hooksPath /dev/null'
check deny 'git config --local core.hooksPath .nohooks'
# Adversarial probe 2026-11-07: each of these skipped a failing pre-commit hook in git 2.56.0.
check deny 'git commit --no-verif -m x'         # git accepts unambiguous long-option prefixes
check deny 'git commit --no-veri -m x'
# The same prefixes skipped a failing pre-push hook in git 2.43 (--no-veri also in 2.56.0).
check deny 'git push --no-veri origin main'
check deny 'git push --no-verif origin main'
check ask 'git push --no-verbose origin main'
check - 'git commit --no-verbose -m x'
# For commit, push and rebase, --no-v to --no-ver are ambiguous with --no-verbose; am has no --verbose, so git 2.56.0
# reads them as --no-verify there.
check deny 'git am --no-ver 0001.patch'
check deny 'git am --no-v 0001.patch'
# am -n is am's --no-verify; pull has --[no-]verify for the pre-merge-commit and commit-msg hooks.
check deny 'git am -n 0001.patch'
check deny 'git am -3n 0001.patch'
check - 'git am -3 -s 0001.patch'
check deny 'git pull --no-verify origin main'
check - 'git pull --no-verify-signatures origin main'
check - 'git merge --no-verify-signatures feature'
check deny 'SKIP=flake8 git commit -m x'
check deny 'HUSKY=0 git push origin main'
check deny 'export LEFTHOOK=0; git commit -m x'
# --- deny: more ways to set core.hooksPath ---
check deny 'git config set core.hooksPath /dev/null'
check deny 'git config set --local core.hooksPath /dev/null'
check deny 'git config --add core.hooksPath /dev/null'
check deny 'git config --file=.git/config core.hooksPath /dev/null'
check deny 'git config --file .git/config core.hooksPath /dev/null'
check deny 'git config -f .git/config core.hooksPath /dev/null'
check deny 'git config --type path core.hooksPath /dev/null'
check deny 'git config set --comment hi core.hooksPath /dev/null'
check deny 'git config core.hooksPath 2>/dev/null /dev/null'
check deny 'git -c core.hooksPath=/dev/null switch main'
check deny 'git -c core.hooksPath=/dev/null worktree add ../x'
check deny 'git -C /repo config core.hooksPath /dev/null'
check deny 'git config "core.hooksPath" /dev/null'
check deny 'git -c core.hooksPath=/dev/null pull'
check deny "git -c user.name='a;b' -c core.hooksPath=/dev/null commit -m x"
check deny 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x'
check deny 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0+=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git commit -m x'
check deny "GIT_CONFIG_PARAMETERS=\"'user.name'='a b' 'core.hooksPath'='/dev/null'\" git commit -m x"
check deny 'git --config-env=core.hooksPath=EMPTY commit -m x'
check deny 'H=/dev/null git --config-env  core.hooksPath=H commit -m x'
poison="echo 'git config $(printf -- '--file %.0s' {1..40})x'; git config core.hooksPath /dev/null"
check deny "$poison"
# Adversarial probe 2026-11-07: set this way, the hook path skipped a failing pre-commit hook in git 2.56.0.
check deny 'git config --local --replace-all core.hooksPath /dev/null'
# A read ends only at spaces or tabs and then a separator or the end: bash passes VT, FF and CR on to git as a value.
check deny $'git config core.hooksPath \v'
check deny $'git config core.hooksPath \f'
check deny $'git config core.hooksPath \r'
# Removing the core section: git accepts unambiguous prefixes of --remove-section, and the remove-section subcommand.
check deny 'git config --remove-sec core'
check deny 'git config --rem core'
check deny 'git config remove-section core'
check deny 'git config remove-section --local core'
check - 'git config remove-section alias'
check - 'git config --remove-sec alias.x'
# Renaming the core section moves core.hooksPath out of it, which switches a Husky-style hook off. git 2.56.0 accepts
# prefixes of --rename-section, and the rename-section subcommand since 2.46.
check deny 'git config --rename-sec core foo'
check deny 'git config --ren core foo'
check deny 'git config rename-section core foo'
check - 'git config rename-section foo bar'
check - 'git config --rename-section foo bar'
# Renaming another section into core moves its keys, a hook path among them, into core.
check deny 'git config --rename-section foo core'
check deny 'git config rename-section foo core'
# --- deny: secrets on a command line or stdout (the 81f803e1 pattern first) ---
check deny "KEY=\$(podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key | tr -d '\\n'); curl -s -H \"Authorization: Bearer \$KEY\" http://127.0.0.1:8080/v1/models; unset KEY"
check deny 'curl --header "authorization: bearer ${TOKEN}" https://example.com'
check deny 'curl --oauth2-bearer "$TOKEN" https://example.com'
check deny 'podman secret inspect --showsecret llama_api_key'
check deny "podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key | tr -d '\\n'"
check deny "echo \"\$(podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key)\""
check deny 'git commit --no-verify && git push'   # deny wins over ask
# --- global options with a space before the value (git 2.56.0 takes the next word; these were allowed before) ---
# BEGIN space-value global options
check ask 'git --git-dir /srv/repo push origin main'   # not .git here: the git in .git would match on its own
check deny 'git --git-dir /srv/repo commit --no-verify -m x'
check deny 'git --git-dir /srv/repo config --remove-section core'
check - 'git --git-dir .git status'
check ask 'git --work-tree . push origin main'
check deny 'git --work-tree . commit --no-verify -m x'
check deny 'git --work-tree . config --remove-section core'
check - 'git --work-tree . status'
check ask 'git --namespace ns push origin main'
check deny 'git --namespace ns commit --no-verify -m x'
check deny 'git --namespace ns config --remove-section core'
check - 'git --namespace ns log -1'
check ask 'git --attr-source HEAD push origin main'
check deny 'git --attr-source HEAD commit --no-verify -m x'
check deny 'git --attr-source HEAD config --remove-section core'
check - 'git --attr-source HEAD diff'
check ask 'git --config-env user.name=U push origin main'
check deny 'git --config-env user.name=U commit --no-verify -m x'
check deny 'git --config-env user.name=U config --remove-section core'
check - 'git --config-env user.name=U status'
check ask "git -C repo --git-dir 'a b/.git' --work-tree \"a b\" --no-pager push"
check ask 'git --git-dir -c push origin main'   # the value may start with -: git takes it as the path
check - 'git --git-dir .git --work-tree . stash push -m wip'
check - 'git --git-dir=.git status'
check - 'git --git-dir push'   # git 2.56.0 takes push as the path and runs no subcommand; this asked before
# Known gaps (main too): values are read without shell escapes, so these reach no subcommand and are allowed.
check - "git --git-dir='a b/.git' push"
check - 'git --work-tree="a b" push origin main'
check - 'git -C a\ b push'
check - "git -C a\\'b push origin main"
check - "git --git-dir a\\'b push"
# A --flag=value with an escaped quote is still read whole by =\S+, as before. Earlier drafts of this change that read
# shell escapes allowed these, then the $$'..' cases further down (security reviews, 2026-11-08).
check ask "git --namespace='it'\\''s' push origin main"
check ask 'git --namespace="a\"b" push origin main'
check ask "git --namespace=\$'a\\'b' push origin main"
check ask "git --namespace=a\\'b push origin main"
check ask 'git --git-dir=x\"y push'
check deny 'git --git-dir="a\"b/.git" commit -n -m x'
check deny "git --namespace='it'\\''s' commit --no-verify -m x"
check deny "HUSKY=0 git --namespace='it'\\''s' commit -m x"
check ask "git -c x.y=\$\$'\\' push origin main; echo 'pushed ok'"   # bash reads $$ first, then '\' as plain quotes
check ask "git -C \$\$'a\\' push 'b c'"
check ask "git --namespace=\$\$'a\\' push 'b c'"
check deny "git -c x.y=\$\$'\\' commit --no-verify -m 'b c'"
check deny "git -c x.y=\$\$'\\' commit -n -m 'b c'"
check deny "HUSKY=0 git -c x.y=\$\$'\\' commit -m 'b c'"
# --shallow-file (undocumented; git 2.56.0 takes the next word, and has no = form). Reviewer, 2026-11-08: read as a bare
# flag, it let a following space option swallow the subcommand: the first five were ask or deny before 587e9ad, which
# allowed them. The next five were allowed on main too, so they close an older gap.
check ask 'git --shallow-file --work-tree push origin main'
check deny 'git --shallow-file --git-dir commit -n -m x'
check deny 'git --shallow-file --namespace commit --no-verify -m x'
check deny 'git --shallow-file --attr-source config --remove-section core'
check deny 'HUSKY=0 git --shallow-file --config-env commit -m x'
check ask 'git --shallow-file nosuch push origin master'
check deny 'git --shallow-file x commit -am x --no-verify'
check deny 'git --shallow-file x commit -n -m x'
check deny 'git --shallow-file x config --remove-section core'
check deny 'HUSKY=0 git --shallow-file x commit -m x'
check - 'git --shallow-file x log --oneline'
# git takes push as the file and origin as the subcommand; this asked before. Like any git command, it pushes only if a
# config alias or a git-origin program makes origin a push (config aliases are left to the written rules).
check - 'git --shallow-file push origin'
check ask 'git --shallow-file=x push'   # known false positive: git rejects --shallow-file= as an unknown option
# END space-value global options
# --- an empty value after = does not end the options run; the subcommand after it is still read ---
# BEGIN empty-value global options
check ask 'git --namespace= push origin main'
check deny 'git --namespace= commit --no-verify -m x'
check deny 'git --namespace= config --remove-section core'
check - 'git --namespace= log -1'
check ask 'git --attr-source= push origin main'
check deny 'git --attr-source= commit --no-verify -m x'
check deny 'git --attr-source= config --remove-section core'
check - 'git --attr-source= diff'
check ask 'git --exec-path= push origin main'
check deny 'git --exec-path= commit --no-verify -m x'
check deny 'git --exec-path= config --remove-section core'
check - 'git --exec-path= status'
check ask 'git --namespace= --attr-source= -C repo --exec-path= push'
check deny 'git --namespace= commit -n -m x'
check deny 'HUSKY=0 git --attr-source= commit -m x'
check ask 'git --namespace= push --dry-run; git --namespace= push'
check - 'git --namespace= push --dry-run origin main'
# These four ask or deny conservatively: the guard reads any empty --flag= the same way.
check ask 'git --git-dir= push'
check ask 'git --work-tree= push'
check deny 'git --config-env= commit --no-verify -m x'
check ask 'git --list-cmds= push'
check deny 'git --git-dir= config --global --remove-section core'
check - 'git --namespace= -C git stash push'
# END empty-value global options
# A value that ends in git is not taken as a value (that kept long git -C git ... chains quadratic); the git it ends in
# starts a match of its own, so these still decide as before.
check ask 'git -C git push origin main'
check ask 'git -c user.name=git push'
check ask 'git --work-tree git push'
check - 'git -C git status'
# Security review 2026-11-08: the SKIP/HUSKY rule needed its git after a space, so these were allowed by the change above.
check deny 'HUSKY=0 git -C ~/src/git commit -m x'
check deny 'HUSKY=0 git -c user.name=git commit -m x'
check deny 'SKIP=all git -C .git commit -m x'
check deny 'PRE_COMMIT_ALLOW_NO_CONFIG=1 git -C vendor/git commit -m x'
check deny 'HUSKY=0 git -c core.editor=git merge topic'
check deny 'SKIP=lint git -C ~/git push origin main'
check deny 'HUSKY=0 git --git-dir ~/r/.git commit -m x'   # allowed before this change as well
check deny 'HUSKY=0 /usr/bin/git commit -m x'   # allowed before: the rule needed git right after a space
check - 'HUSKY=0 npm test && git -C ~/src/git status'
# The rule is anchored at the first assignment on each line: a later line, or a later assignment, still counts.
check deny $'ls\nHUSKY=0 git commit -m x'
check deny 'SKIP= true; LEFTHOOK=0 git commit -m x'
# Known false positive (main too): the rule runs past a ; separator, so a SKIP= that reaches only true still counts.
check deny 'a=1 SKIP=x true; git -C ~/src/git commit -m x'
# grep matches line by line, so the rule never spans lines. Known gap (main too): export HUSKY=0 on one line and a git
# commit on the next skips Husky's hooks and is allowed.
check - $'SKIP=1 true\ngit commit -m x'
# Known false positives added by this change (main allowed both): after an assignment, a git that follows any character
# other than a word character or -, such as a quote, /, ., = or :, counts too (HUSKY=0 make DIR=git commit denies).
check deny 'HUSKY=0 npm test; echo "git commit"'
check deny 'HUSKY=0 make -C ~/src/git commit'

# --- no decision: reads, safe forms, and near misses ---
check - 'git status && git log --oneline -3'
check - 'git commit -m "push the fix to the docs"'
check - 'git commit -m "use -n for dry runs"'
check - 'git commit -uno -m x'
check - 'git commit --amend --no-edit'
check - 'git commit -m"new"'
check - 'git push --dry-run origin main'
check - 'python3 -c '"'"'import subprocess; subprocess.run(["git", "status"], check=True)'"'"
check - 'python3 -c '"'"'import subprocess; subprocess.run(["git", "log", "--grep", "push"])'"'"
check - "python3 -c \"import subprocess; subprocess.run(['git', 'commit', '-m', 'push'])\""
check - 'python3 -c '"'"'import subprocess; subprocess.run(["git", "stash", "push", "-m", "wip"])'"'"
check - 'python3 -c '"'"'import subprocess; subprocess.run(["git", "push", "--dry-run", "origin", "main"])'"'"
check - 'python3 -c '"'"'import subprocess; subprocess.run(["git-lfs", "ls-files"]); print("push")'"'"
check - 'git -c alias.lg="log --graph --oneline" lg -5'
check - 'git -c alias.sp="stash push" sp -m wip'
check - 'git -c alias.st=status -c alias.pushed=log st'
check - 'git -c alias.p=push p --dry-run origin main'
# --- -c with a push.* key is config, not the push subcommand ---
check - 'git -c push.default=simple status'
check - 'git -c push.autoSetupRemote=true commit -m x'
check - "toolbox run --container dev-infra-hermes bash -c 'git -C repo -c push.default=current log -1'"
check ask 'git -c push.default=simple push origin main'
check ask 'git -c push.default=current -C repo push'
# --- more argv-list and alias forms (held-out cases from the 2026-10-25 A/B test) ---
check ask "python3 -c \"import subprocess; subprocess.check_call(['git','push'])\""
check ask "python3 -c 'import subprocess as sp; sp.call([\"git\",\"push\"])'"
check ask "python3 -c 'import subprocess; subprocess.Popen([\"/usr/bin/git\", \"push\", \"origin\", \"main\"])'"
check ask "python3 -c 'import subprocess; repo=\"x\"; subprocess.run([\"git\", \"-C\", repo, \"push\"])'"
check ask "python3 -c 'import subprocess; k=\"x\"; subprocess.run([\"git\", \"-c\", f\"user.name={k}\", \"push\"])'"
check ask 'python3 -c "import subprocess; subprocess.run([\"git\", \"push\"])"'
check ask $'python3 - <<\'EOF\'\nimport subprocess\nsubprocess.run(["git", "push"])\nEOF'
check ask "git -c alias.up='push -u' up origin feat"
check ask 'git -c "alias.pp=push --force-with-lease" pp'
check ask 'git -c alias.P=push P'
check ask 'git -c alias.p=push -c user.name=x p origin main'
check ask 'bash -c "git -c \"alias.pf=push --force\" pf origin b"'
check - "git -c alias.sp='stash push' sp"
check - "git -c alias.lg='log --oneline' lg"
check - 'git config --get core.hooksPath'
check deny 'git config --unset core.hooksPath'   # unsetting it switches hooks off where a repo sets it (Husky)
check - 'git config get core.hooksPath'
check deny 'git config core.hooksPath 2>/dev/null'   # known false positive: a redirect after the key can hide a value
check - 'git config core.hooksPath || echo unset'
check deny "grep -rn 'core.hooksPath' docs"   # known false positive: any mention outside a git config read denies
# Known false positive (adversarial validation, 2026-11-07): a read-only grep whose pattern names the key. Exempting
# even a piped grep would let its output reach git config as the key: read -r k < <(... | grep -o '...'; ).
check deny "git -C ~/code/repos/claude-optimization show 0a1600d:hooks/test-bash-guard.sh | grep -nE 'unset core\\.hooksPath|core\\.hooksPath=/dev/null clone'"
# --- deny: forms the review of the inverted rule found (redirects, quote splits, grep words) ---
check deny 'git config core.hooksPath &>/dev/null /tmp/x'
check deny "git config core.hooksPath >'|' /tmp/x"
check deny "git config core.hooksPath 2>';' /tmp/x"
check deny 'git config core.hooksPath >\) /tmp/x'
check deny 'git config core.hoo"ks"Path /tmp/x'
check deny 'git config core\.hooksPath /tmp/x'
check deny "git config core.hooks''Path /tmp/x"
check deny "git config --comment rg 'core.hooksPath' /tmp/x"
check - 'git config --get-regexp core.hooksPath x'
check deny 'git config --unset core.hooksPath || true'
check deny 'git config unset core.hooksPath'
check deny 'echo /dev/null | xargs git config core.hooksPath'   # xargs adds the value
check deny 'printf /dev/null | xargs -d\; git config core.hooksPath'   # an escaped ; is not a command start
check deny 'printf /dev/null | xargs -d\| git config core.hooksPath'
check deny 'git config --remove-section core'
check deny 'git config --rename-section core x'
check deny "git commit -m 'guard: deny core.hooksPath writes'"   # known false positive: a message naming the key
check - 'if git config --get core.hooksPath; then echo set; fi'
check - '! git config --get core.hooksPath'
check - 'time git config core.hooksPath'
check - 'git config --remove-section alias.x'
# --- deny: quoted values that look like the end of a read once quotes are removed ---
check deny "git config core.hooksPath ''"
check deny 'git config core.hooksPath ""'
check deny "git config core.hooksPath ';'"
check deny 'git config core.hooksPath \|'
check deny "git config --global core.hooksPath ')'"
check deny "git config core.hooksPath '&&' x"
check deny "git config core.hooksPath '' && git commit -m x"
check deny "git config core.hooks\$'P'ath /dev/null"
check deny "git -c core.hooks\$''Path=/dev/null commit -m x"
check deny "git -c 'core.hooksPath=/dev/null clone' commit -m x"
check - 'git config --get core.hooksPath || echo unset'
check - 'x=$(git config get core.hooksPath)'
check deny 'GIT_CONFIG_PARAMETERS="x" git log; grep -rn core.hooksPath docs'   # known false positive: an unquoted mention
check deny 'git -c core.hooksPath=/dev/null --bare clone https://github.com/x/y'   # known false positive: clone must follow -c
check deny 'echo core.hooksPath'   # known false positive: any mention outside a read denies
# --- deny: forms the last review found, now caught because they mention the key ---
check deny 'git clone --config core.hooksPath=/dev/null https://github.com/x/y'
check deny "git -c alias.c='-c core.hooksPath=/dev/null commit' c -m x"
check deny 'git --work-tree . config core.hooksPath /dev/null'
check deny "python3 -c \"import subprocess; subprocess.run(['git','-c','core.hooksPath=/dev/null','commit','-m','x'])\""
check deny 'git -c "core.hooksPath"=/dev/null commit -m x'
check deny "GIT_CONFIG_PARAMETERS=\"'user.name'='a;b' 'core.hooksPath'='/dev/null'\" git commit -m x"
check deny 'git config --comment --get core.hooksPath /dev/null'
check deny 'git config core."hooksPath" /dev/null'
check deny 'git config core.hooksPath > out.txt /dev/null'
check - 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m x'
check - 'cat .git/hooks/pre-commit && ls .git/hooks'
check - 'SKIP=1 ./run.sh && git status'
check - 'gh pr view 37 --json state,isDraft'
check - 'gh pr list --repo securexai/dev-toolbox --state all'
check - 'gh api repos/securexai/x/pulls'
check - 'gh api -X GET search/issues -f q=repo:securexai/x'
check - "gh api graphql -f query='query { viewer { login } }'"
check - "KEY=\$(podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key | tr -d '\\n'); printf 'Authorization: Bearer %s\\n' \"\$KEY\" | curl -s -m 10 -H @- http://127.0.0.1:8080/v1/models; unset KEY"
check - "served() { KEY=\$(podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key | tr -d '\\n'); printf 'Authorization: Bearer %s\\n' \"\$KEY\" | curl -s -H @- http://127.0.0.1:8080/props; }"
check - "curl -s -H 'Content-Type: application/json' http://127.0.0.1:8080/health"
check - "ps -eo pid,etime,cmd | grep -i 'git push\\|ssh ' | grep -v grep | head"   # replay false positive
check - "jq -r '.input.command? // empty' t.jsonl | grep -E 'git push|GIT_SSH|ssh-add' | tail -5"
check deny 'git -c core.hooksPath=/dev/null clone --quiet --depth 50 https://github.com/x/y "$D/src"'   # was allowed; a quoted value can fake the clone
check - 'python3 -c '"'"'import subprocess; k = subprocess.run(["podman", "secret", "inspect", "--showsecret", "llama_api_key"], capture_output=True)'"'"
check - "grep -rn 'Bearer \$KEY' docs/"
check ask "grep -q done status.txt || git push origin main"
check ask 'git ls-remote origin && NO_COLOR=1 git push origin --delete codex/old-a codex/old-b'
check ask 'timeout 60 gh repo create securexai/hermes-ops --private --description x'
check deny "podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key | command grep -a -c -F -f - out.log"
check - 'npm test'
check - 'tail -f server.log' Monitor
check - ''

# --- failure handling: bad input must fail (onFailure "block" then blocks the call) ---
if printf 'not json' | "$hook" >/dev/null 2>&1; then
  fail=$((fail + 1)); echo "FAIL malformed input exited 0"
else
  pass=$((pass + 1))
fi
# A check that cannot be decided must block: a stand-in grep that always exits 2 must make the hook exit 2.
fake=$(mktemp -d)
printf '#!/bin/sh\nexit 2\n' >"$fake/grep"
chmod +x "$fake/grep"
jq -cn '{tool_name: "Bash", tool_input: {command: "git status"}}' | PATH="$fake:$PATH" "$hook" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL a grep error gave exit $rc, not 2"; fi
# The same for count(): a grep that fails only when asked for -o (count's mode) must also make the hook exit 2.
realgrep=$(command -v grep)
printf '#!/bin/sh\nfor a; do [ "$a" = -oP ] && exit 2; done\nexec %s "$@"\n' "$realgrep" >"$fake/grep"
jq -cn '{tool_name: "Bash", tool_input: {command: "git status"}}' | PATH="$fake:$PATH" "$hook" >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL a grep error in count gave exit $rc, not 2"; fi
rm -rf "$fake"
# An early match followed by a long tail: grep stops reading, printf gets SIGPIPE, and that must not read as no match.
tail="$(head -c 120000 /dev/zero | tr '\0' x)"   # past the 64 KiB pipe buffer, under the 128 KiB argument limit
check deny "git config core.hooksPath /dev/null; echo $tail"
check ask "git push origin main; echo $tail"
# A command over 64 KiB with no file writes allowed (as with a full /tmp) must still reach the rules and be denied.
big="$(head -c 70000 /dev/zero | tr '\0' x); git config core.hooksPath /dev/null"
out=$(jq -cn --arg c "$big" '{tool_name: "Bash", tool_input: {command: $c}}' | (trap '' XFSZ; ulimit -f 0; "$hook") 2>/dev/null)
if [ "$(jq -r '.hookSpecificOutput.permissionDecision // "-"' <<<"${out:-null}" 2>/dev/null)" = deny ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL a long command with no file writes allowed was not denied"
fi
# A tool input without a command (Monitor's WebSocket form) passes through.
if [ -z "$(jq -cn '{tool_name: "Monitor", tool_input: {ws: {url: "wss://x"}}}' | "$hook")" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL ws-only Monitor input produced a decision"
fi

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
