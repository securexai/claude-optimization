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
check deny 'SKIP=flake8 git commit -m x'
check deny 'HUSKY=0 git push origin main'
check deny 'export LEFTHOOK=0; git commit -m x'
# --- deny: secrets on a command line or stdout (the 81f803e1 pattern first) ---
check deny "KEY=\$(podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key | tr -d '\\n'); curl -s -H \"Authorization: Bearer \$KEY\" http://127.0.0.1:8080/v1/models; unset KEY"
check deny 'curl --header "authorization: bearer ${TOKEN}" https://example.com'
check deny 'curl --oauth2-bearer "$TOKEN" https://example.com'
check deny 'podman secret inspect --showsecret llama_api_key'
check deny "podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key | tr -d '\\n'"
check deny "echo \"\$(podman secret inspect --showsecret --format '{{.SecretData}}' llama_api_key)\""
check deny 'git commit --no-verify && git push'   # deny wins over ask

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
check - 'git config --unset core.hooksPath'
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
check - 'git -c core.hooksPath=/dev/null clone --quiet --depth 50 https://github.com/x/y "$D/src"'
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
# A tool input without a command (Monitor's WebSocket form) passes through.
if [ -z "$(jq -cn '{tool_name: "Monitor", tool_input: {ws: {url: "wss://x"}}}' | "$hook")" ]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL ws-only Monitor input produced a decision"
fi

echo "pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
