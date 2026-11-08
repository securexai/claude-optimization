#!/usr/bin/env bash
# bash-guard.sh: PreToolUse hook for the Bash and Monitor tools.
#
# Enforces the hard limits from ~/.claude/CLAUDE.md that text alone has missed:
#   deny - skipping git hooks (--no-verify and every prefix of it down to --no-v: git accepts --no-veri and
#          --no-verif, and for am, which has no --verbose, --no-v and up; commit -n, am -n; SKIP/HUSKY/LEFTHOOK), or
#          any mention of core.hooksPath that is not a known read of it (see the rule below);
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
# so a crash blocks the call instead of letting it through, and a check that cannot be decided
# (grep fails or never runs) exits 2 so it blocks too. Tests: test-bash-guard.sh.
# It is a backstop, not a parser: quoting tricks, run-time assembly, other config files and Git 2.54
# config-based hooks (hook.NAME.*) are left to the written rules in CLAUDE.md and the git-workflow skill.
# Known limitations: a backslash-newline continuation is joined with a space, while bash joins it with nothing, so a
# word split across one is read as two words; and the --no-verify scan stops at a ; & or | even inside quotes, so a
# --no-verify after a quoted argument that holds one (git commit -m 'a; b' --no-verify) is missed. Global-option values
# are read without shell escapes: an escaped quote in a -C, -c or space-separated value (git -C a\'b commit -n,
# git -c k=$'a\'b' push) shifts the quote pairing and hides the subcommand, so its push or hook bypass is missed; a
# quoted space after = (--git-dir='a b') or an escaped space (-C a\ b) ends the options run the same way.
set -euo pipefail

# 1 also asks before every git commit. CLAUDE.md's "ask before commits" held in the
# probes and history, so commits stay text-only by default.
ask_on_commit=0

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')   # a pipe: no temp file needed
[ -n "$cmd" ] || exit 0
cmd=${cmd//$'\\\n'/ }   # join backslash-newline continuations
# For the core.hooksPath rule, both taken before the grep-pattern rewrite below. rawcmd keeps the quotes, so a read is
# only a read when its key and what follows are literal. hptext drops quotes, backslashes and the $ of $'..' and $"..",
# as the shell does, so core.hoo"ks"Path, core\.hooksPath and core.hooks$'P'ath are all seen as core.hooksPath.
rawcmd=$cmd
hptext=$(printf '%s' "$cmd" | sed -E "s/[\$]([\"'])/\\1/g" | tr -d "\"'\\\\")
# A quoted grep/rg pattern is search text, not a command: grep -E 'git push|ssh' must not ask.
cmd=$(printf '%s\n' "$cmd" | sed -E "s/(^|[^[:alnum:]_-])((e|f)?grep|rg)((\s+-[^[:space:]]+)*)\s+('[^']*'|\"[^\"]*\")/\1\2\4 PATTERN/g")

decide() { # decide <ask|deny> <reason>
  jq -cn --arg d "$1" --arg r "bash-guard: $2" \
    '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: $d, permissionDecisionReason: $r}}'
  exit 0
}
# Matching fails closed: each check is judged by grep's own exit status from PIPESTATUS (0 match, 1 no match; anything
# else, such as a pattern error, PCRE's backtracking limit or grep missing, exits 2, which blocks). Pipes, not
# here-strings, so a full /tmp cannot stop grep from running; printf's own status (a SIGPIPE after an early match on a
# long command) is ignored.
undecided() { # undecided <rc>: say why, then exit 2 so onFailure "block" blocks the call
  echo "bash-guard: a check could not be decided (grep exit ${1:-none}); blocking" >&2
  exit 2
}
has_in() { # has_in <text> <pattern>. Call it only as a condition (if, ||, &&), where set -e does not apply.
  printf '%s\n' "$1" | command grep -qP -- "$2"
  local rc=${PIPESTATUS[1]}
  case $rc in
    0) return 0 ;;
    1) return 1 ;;
    *) undecided "$rc" ;;
  esac
}
has() { has_in "$cmd" "$1"; }
# argv lists in heredocs span lines. The joined text is built once, with tr: bash's ${cmd//$'\n'/ } takes seconds on a
# few hundred KB, close to the hook's timeout.
joined=$(printf '%s' "$cmd" | tr '\n' ' ')
has_joined() { has_in "$joined" "$1"; }
count() { count_in "$cmd" "$1"; }
count_in() { # count_in <text> <pattern>: the number of matches. Call it only as a plain assignment, where set -e sees a failure.
  local n rc=0
  n=$(printf '%s\n' "$1" | command grep -oP -- "$2" | wc -l; exit "${PIPESTATUS[1]}") || rc=$?
  case $rc in
    0 | 1) echo "${n:-0}" ;;
    *) undecided "$rc" ;;
  esac
}

q="[\"']?"   # an optional opening quote
# "git", then only global options (-C dir, -c k=v, --flag[=v], --opt v), then the subcommand.
# A -C/-c value is one shell word, quotes included: -c alias.sp='stash push' is not a push.
# -c/-C never stand alone as a flag, or -c push.default=simple would read as the subcommand push.
# spaceopt lists the long options git 2.56.0 takes with the next word as their value: five that git(1) documents with =
# (--git-dir, --work-tree, --namespace, --attr-source, --config-env) and the undocumented --shallow-file, which has no
# = form. Other options git(1) shows with = do not take the next word: --list-cmds needs =, and --exec-path without =
# prints the path and exits. To recheck after a git upgrade, run this (strings is from binutils; the binary under
# git --exec-path is the real one even behind a shim); it prints the options other than --config-env:
#   for o in $(strings "$(git --exec-path)/git" | grep -oE '^--[a-z-]+$' | sort -u); do
#     [ "$(git "$o" nosuch hash-object --stdin </dev/null 2>/dev/null)" = e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 ] && echo "$o"
#   done
# and for --config-env put a.b=HOME (a dotted key and a set variable) in place of nosuch. Options in spaceopt always take
# that word, even one starting with -, as git does; written without = they never match as a bare --flag. So each word
# reads one way only, and a long run of options cannot backtrack.
# A value word may not end in a git that could start a match (git -C git, -c k=git): that git is then tried as a start
# of its own and reads the same words that follow. Otherwise each git in a chain such as git -C git -C git ... is both a
# value and a start that scans to the end, which is quadratic: seconds on a 10,000-word command. A --flag=value reads
# its value as \S*, with the same rule, so --namespace=x/git chains stay linear too. The value may be empty, so an empty
# =value (git --namespace= push) does not end the options run: the subcommand after it is still read.
# The inline-alias pattern (alias_push) reads =\S+, so an alias starting with --exec-path= is not matched.
# Words are read as before this change: no shell escapes (\x, $'..', \" inside ".."). Reading them was tried and each
# version hid a subcommand in a new way ('it'\''s', then $$'..'). So, as before, an escaped quote in a -C, -c or space-
# separated value hides the subcommand, and a quoted space after = or an escaped space ends the options run (see Known
# limitations at the top).
word="(?:[^\\s'\"]|'[^']*'|\"[^\"]*\")+(?<!(?<![\\w-])git)"   # one shell word, quotes included
spaceopt='(?:git-dir|work-tree|namespace|attr-source|config-env|shallow-file)'
git="(?<![\\w-])git(?:\\s+(?:-[Cc]\\s+${word}|--${spaceopt}\\s+${word}|--(?!${spaceopt}(?![\\w=-]))[A-Za-z][\\w-]*(?:=\\S*(?<!(?<![\\w-])git))?|-[A-BD-Za-bd-z][A-Za-z]*))*\\s+"
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
if has "${git}(?:commit|push|merge|pull|rebase|am|cherry-pick|revert)\\b${seg}\\s--no-v(?:e(?:r(?:i(?:fy?)?)?)?)?(?![\\w-])" ||
   has "${git}commit(?:\\s+(?:'[^']*'|\"[^\"]*\"|[^\\s;&|'\"][^\\s;&|]*))*?\\s-[aeiopqsvz]*n[A-Za-z]*(?![\\w-])" ||
   has "${git}am(?:\\s+(?:'[^']*'|\"[^\"]*\"|[^\\s;&|'\"][^\\s;&|]*))*?\\s-[3ckimqrsu]*n[A-Za-z0-9]*(?![\\w-])"; then
  decide deny "Skipping git hooks is never allowed here (CLAUDE.md: never bypass hooks). Fix what the hook reports, or stop and tell the user."
fi
# core.hooksPath: any mention of it denies, unless the mention is part of a known read. Listing every way to write it
# (-c, git config [set], clone --config, aliases, GIT_CONFIG_*, --config-env, argv lists, quoting) never converged
# in review, while a mention is easy to see. Mentions are counted on hptext (quotes, backslashes and the $ of $'..'
# removed, grep patterns not rewritten); reads are matched on rawcmd, where quotes still show. The only reads: git at
# the start of a command (line start, or after an unescaped ; & | ( or $( , optionally after if, then, elif, do, ! or
# time, so xargs or another wrapper cannot add a value), then `config [scope] core.hooksPath` followed only by spaces
# or tabs and then the end, ;, &&, ||, | or ) (bash passes VT, FF and CR on as a value; no redirects: a redirect can
# hide a value), or `config [scope] get|--get* [scope] core.hooksPath`. Everything else denies: removing it (in a repo
# that sets it, such as Husky's .husky/_, unset switches the hooks off), removing or renaming the core section or
# renaming another section into it (any option starting --rem or --ren, which covers every prefix of --remove-section
# and --rename-section that git accepts, or the remove-section and rename-section subcommands of git 2.46 and later),
# `-c core.hooksPath=... clone`, and text such as
# `echo core.hooksPath`, a grep for it or a commit message naming it (known false positives). Each read matches
# exactly one mention, so mentions > reads means a non-read. Out of reach: escapes inside $'..' that spell the key.
hp='(?i:core\.hookspath)'
scope='(?:(?:--(?:local|global|system|worktree|show-origin|show-scope|null|includes|no-includes)|-z)\s+)*'
atcmd='(?:^|(?<=[;&|(])(?<!\\[;&|(])|(?<=\$\())\s*(?:(?:if|then|elif|do|!|time)\s+)?'
readhp="${atcmd}git\\s+config\\s+${scope}${hp}(?=[ \\t]*(?:;|&&|\\|\\|?|\\)|\$))"
readhp+="|${atcmd}git\\s+config\\s+${scope}(?:--get(?:-[\\w-]+)?|get)\\s+${scope}${hp}"
hp_mentions=$(count_in "$hptext" "${hp}")
hp_reads=0
# Reads are matched on rawcmd: a quoted key or value, or a quoted ; | ) that looks like a separator once quotes are
# gone, is not a literal read, so it counts as a mention without a read and denies.
if [ "$hp_mentions" -gt 0 ]; then hp_reads=$(count_in "$rawcmd" "${readhp}"); fi
# The SKIP/HUSKY rule lets its git start inside a word (\S*?), like every other ${git} rule: a value ending in git (-C
# ~/src/git) is not taken as a value, so the match starts at that git, and /usr/bin/git is caught the same way. It is
# anchored at the first assignment on the line (\A and an atomic group; grep matches line by line): any git after a
# later one is also after the first, and starting again at every VAR= made HUSKY=0 HUSKY=0 ... take seconds.
if [ "$hp_mentions" -gt "$hp_reads" ] ||
   has "${git}config\\s+(?:\\S+\\s+)*?(?:--re[mn][a-z-]*|re(?:move|name)-section)\\s+(?:[^\\s;&|]+\\s+)*?${q}(?i:core)${q}(?![\\w.-])" ||
   has "\\A(?>.*?(?<![\\w.-])(?:SKIP|HUSKY|LEFTHOOK|PRE_COMMIT_ALLOW_NO_CONFIG)=)\\S*\\s+(?:\\S+\\s+)*?\\S*?${git}(?:commit|push|merge)(?![\\w-])"; then
  decide deny "Changing or disabling git hooks counts as bypassing them. Ask the user; they can run it themselves with ! if they want it."
fi

# --- deny: secrets on a command line or stdout ---
if has "(?i)(?:-H|--header)[=\\s]*${q}authorization:\\s*bearer\\s+${q}\\$|--oauth2-bearer[=\\s]+${q}\\$"; then
  decide deny "A secret expanded into a command-line argument is visible in the process list. Pipe the header instead: printf 'Authorization: Bearer %s\\n' \"\$KEY\" | curl -H @- ..."
fi
shown=$(count 'podman\s+secret\s+inspect\b[^\n;&|)]*--showsecret')
captured=$(count '\b[A-Za-z_]\w*=\$\(\s*podman\s+secret\s+inspect\b[^\n;&|)]*--showsecret')
if [ "$shown" -gt 0 ] && [ "$captured" -lt "$shown" ]; then
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
