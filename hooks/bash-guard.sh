#!/usr/bin/env bash
# bash-guard.sh: PreToolUse hook for the Bash and Monitor tools.
#
# Enforces the hard limits from ~/.claude/CLAUDE.md that text alone has missed:
#   deny - skipping git hooks (--no-verify, commit -n, core.hooksPath, SKIP/HUSKY/LEFTHOOK);
#        - an Authorization: Bearer $VAR header on a command line (argv is readable by
#          other processes); pipe it instead: printf 'Authorization: Bearer %s\n' "$KEY" | curl -H @-
#        - podman secret inspect --showsecret whose output isn't captured with VAR=$(...).
#   ask  - git push, and gh writes (PR, issue, release, repo, api), anywhere in the command,
#          including inside toolbox run ... bash -c '...'. A push also counts as an argv list
#          (subprocess.run(["git", "push"]), execFileSync("git", ["push"])) or through an inline
#          alias (git -c alias.p=push p). In auto mode this forces a prompt.
# Anything else prints nothing, so the normal permission flow decides.
#
# Matching is by pattern, not a shell parser: a command that only mentions "git push"
# in text (echo, heredoc) also asks, and one that hides it (an alias saved with git config,
# an argv list naming git through a variable) does not. Registered with onFailure "block",
# so a crash blocks the call instead of letting it through. Tests: test-bash-guard.sh.
set -euo pipefail

# 1 also asks before every git commit. CLAUDE.md's "ask before commits" held in the
# probes and history, so commits stay text-only by default.
ask_on_commit=0

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
[ -n "$cmd" ] || exit 0
cmd=${cmd//$'\\\n'/ }   # join backslash-newline continuations
# A quoted grep/rg pattern is search text, not a command: grep -E 'git push|ssh' must not ask.
cmd=$(printf '%s\n' "$cmd" | sed -E "s/(^|[^[:alnum:]_-])((e|f)?grep|rg)((\s+-[^[:space:]]+)*)\s+('[^']*'|\"[^\"]*\")/\1\2\4 PATTERN/g")

decide() { # decide <ask|deny> <reason>
  jq -cn --arg d "$1" --arg r "bash-guard: $2" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
  exit 0
}
has() { printf '%s\n' "$cmd" | command grep -qP -- "$1"; }
has_joined() { printf '%s\n' "${cmd//$'\n'/ }" | command grep -qP -- "$1"; }   # argv lists in heredocs span lines
count() { printf '%s\n' "$cmd" | { command grep -oP -- "$1" || true; } | wc -l; }

q="[\"']?"   # an optional opening quote
# "git", then only global options (-C dir, -c k=v, --flag[=v]), then the subcommand.
# A -C/-c value is one shell word, quotes included: -c alias.sp='stash push' is not a push.
# -c/-C never stand alone as a flag, or -c push.default=simple would read as the subcommand push.
git="(?<![\\w-])git(?:\\s+(?:-[Cc]\\s+(?:[^\\s'\"]|'[^']*'|\"[^\"]*\")+|--[A-Za-z][\\w-]*(?:=\\S+)?|-[A-BD-Za-bd-z][A-Za-z]*))*\\s+"
seg='[^\n;&|]*'   # the rest of one simple command
# The same as an argv list: subprocess.run(["git", "-C", repo, "push"]), execFileSync("git", ["push"]).
# Elements are string literals (an outer shell string may escape the quotes as \"); a -C/-c
# value may also be a variable, call, or f-string.
qq="\\\\?[\"']"
lit="${qq}[^\"'\\n]*${qq}"
sep='\s*,\s*'
lgit="${qq}(?:[^\"'\\s,]*/)?git${qq}${sep}\\[?\\s*(?:(?:${qq}-[Cc]${qq}${sep}(?:\\w*${lit}|[\\w.]+(?:\\([^()]*\\))?)|${qq}--?[A-Za-z][\\w-]*(?:=[^\"'\\n]*)?${qq})${sep})*"
lrest='[^\])\n]*'   # the rest of one argv list
# An inline alias that expands to push (-c alias.p=push, -c 'alias.p=-p push'). It asks whether
# or not the alias is invoked, so chains (-c alias.a=push -c alias.b=a b) ask too.
alias_push="(?i:alias)\\.[^\\s=]+=(?:${qq})?(?:--?[A-Za-z][\\w-]*(?:=\\S+)?\\s+)*push(?![\\w-])"

# --- deny: skipping or disabling git hooks ---
if has "${git}(?:commit|push|merge|rebase|am|cherry-pick|revert)\\b${seg}\\s--no-verify(?![\\w-])" ||
   has "${git}commit(?:\\s+(?:'[^']*'|\"[^\"]*\"|[^\\s;&|'\"][^\\s;&|]*))*?\\s-[aeiopqsvz]*n[A-Za-z]*(?![\\w-])"; then
  decide deny "Skipping git hooks is never allowed here (CLAUDE.md: never bypass hooks). Fix what the hook reports, or stop and tell the user."
fi
if has "(?<![\\w-])git\\s+(?:\\S+\\s+)*?-c\\s*${q}(?i:core\\.hookspath)=\\S*(?:\\s+\\S+)*?\\s+(?:commit|push|merge|rebase|am|cherry-pick|revert)(?![\\w-])" ||
   has "(?<![\\w-])git\\s+config\\s+(?:--(?:local|global|worktree|system)\\s+)?(?i:core\\.hookspath)\\s+(?!--)\\S" ||
   has "(?<![\\w.-])(?:SKIP|HUSKY|LEFTHOOK|PRE_COMMIT_ALLOW_NO_CONFIG)=\\S*\\s+(?:\\S+\\s+)*?${git}(?:commit|push|merge)(?![\\w-])"; then
  decide deny "Changing or disabling git hooks counts as bypassing them. Ask the user; they can run it themselves with ! if they want it."
fi

# --- deny: secrets on a command line or stdout ---
if has "(?i)(?:-H|--header)[=\\s]*${q}authorization:\\s*bearer\\s+${q}\\$|--oauth2-bearer[=\\s]+${q}\\$"; then
  decide deny "A secret expanded into a command-line argument is visible in the process list. Pipe the header instead: printf 'Authorization: Bearer %s\\n' \"\$KEY\" | curl -H @- ..."
fi
shown=$(count 'podman\s+secret\s+inspect\b[^\n;&|)]*--showsecret')
if [ "$shown" -gt 0 ] && [ "$(count '\b[A-Za-z_]\w*=\$\(\s*podman\s+secret\s+inspect\b[^\n;&|)]*--showsecret')" -lt "$shown" ]; then
  decide deny "--showsecret output must go into a variable that is never echoed (KEY=\$(podman secret inspect --showsecret ...)), never to stdout."
fi

# --- ask: outward-facing writes ---
dry="(?!${seg}\\s--dry-run(?![\\w-]))"
ldry="(?!${lrest}[\\s\"']--dry-run(?![\\w-]))"
if has "${git}push(?![\\w-])${dry}" || has "${git}-c\\s+(?:${qq})?${alias_push}${dry}" ||
   has_joined "${lgit}${qq}push${qq}${ldry}" || has_joined "${lgit}${qq}-c${qq}${sep}${qq}${alias_push}${ldry}"; then
  decide ask "git push publishes to a remote."
fi
if has '(?<![\w-])gh\s+(?:pr\s+(?:create|merge|edit|close|reopen|comment|review|ready)|issue\s+(?:create|edit|close|reopen|comment|delete|transfer|lock|unlock)|release\s+(?:create|edit|delete|upload)|repo\s+(?:create|delete|edit|rename|archive|fork))(?![\w-])'; then
  decide ask "This gh command changes something on GitHub."
fi
api='(?<![\w-])gh\s+api\b'
if has "${api}${seg}(?:-X\\s*|--method[=\\s]+)${q}(?:POST|PATCH|PUT|DELETE)\\b" ||
   has "${api}\\s+graphql\\b${seg}\\bmutation\\b" ||
   { has "${api}${seg}\\s(?:-[fF]|--field|--raw-field|--input)(?:[=\\s]|\$)" &&
     ! has "${api}\\s+graphql\\b" && ! has "${api}${seg}(?:-X\\s*|--method[=\\s]+)${q}GET\\b"; }; then
  decide ask "This gh api call writes to GitHub."
fi
if [ "$ask_on_commit" = 1 ] && has "${git}commit(?![\\w-])"; then
  decide ask "git commit (ask_on_commit=1 in bash-guard.sh)."
fi
exit 0
