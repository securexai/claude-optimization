#!/usr/bin/env bash
# model-cheap.sh CHECK: run inside the test container with only the token in the environment. Each CHECK prints result
# lines holding counts and verdicts, never model text, and run.sh judges them. Each model call is one Haiku turn capped
# at $0.05.
#   m1  which instruction files load, from fixtures whose only content is a marker token
#   m2  the slash commands a session lists, in a home built by model-home.sh
#   m3  whether a repo's guidance loads: a control on the unpatched clone, then the same question with /patch.diff applied
#   m4  whether the global rule in this repo's CLAUDE.md names the review commands
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

# ask PROMPT: one turn with no tools from the current directory. Prints the JSON result with the token redacted.
ask() {
  local raw
  raw=$(claude -p "$1" --max-turns 1 --max-budget-usd 0.05 --model claude-haiku-5-5 --tools "" \
    --strict-mcp-config --no-session-persistence --permission-mode dontAsk --output-format json 2>&1 || true)
  printf '%s' "${raw//"$CLAUDE_CODE_OAUTH_TOKEN"/<redacted>}"
}
answer_of() { jq -r '.result // ""' <<<"$1" 2>/dev/null || true; }
status_of() { jq -r '"is_error=\(.is_error) cost=\(.total_cost_usd)"' <<<"$1" 2>/dev/null || echo "is_error=unparsed cost=0"; }

m1_case() {
  local raw tokens
  raw=$(cd "/tmp/fx/$1" && ask "Your instructions may contain marker tokens that look like WORD-xxxx, where WORD is capital letters and xxxx is four hexadecimal characters. Without using any tool, list every such token in the project or user instructions already in this conversation, one per line, with no other text. If there are none, reply NONE.")
  tokens=$(answer_of "$raw" | grep -oE '\b[A-Z]+-[0-9a-f]{4}\b' | LC_ALL=C sort -u | paste -sd, || true)
  # The fixtures hold only synthetic tokens, so this line can carry the answer: it explains a failure when one happens.
  echo "m1 fixture=$1 tokens=${tokens:-none} $(status_of "$raw") answer=$(jq -c '.result // ""' <<<"$raw" 2>/dev/null || echo unparsed)"
}

m1() {
  local marker='Marker token:'
  mkdir -p /tmp/fx/agents-only /tmp/fx/both /tmp/fx/import /tmp/fx/dotclaude/.claude /tmp/fx/home-agents "$CLAUDE_CONFIG_DIR"
  echo "$marker AGENTS-7f3a" >/tmp/fx/agents-only/AGENTS.md
  echo "$marker CLAUDE-91bd" >/tmp/fx/both/CLAUDE.md
  echo "$marker AGENTS-7f3a" >/tmp/fx/both/AGENTS.md
  printf '@AGENTS.md\n\n%s CLAUDE-91bd\n' "$marker" >/tmp/fx/import/CLAUDE.md
  echo "$marker AGENTS-7f3a" >/tmp/fx/import/AGENTS.md
  echo "$marker ROOT-55aa" >/tmp/fx/dotclaude/CLAUDE.md
  echo "$marker DOTCLAUDE-3c9e" >/tmp/fx/dotclaude/.claude/CLAUDE.md
  echo "$marker AGENTS-7f3a" >/tmp/fx/home-agents/AGENTS.md
  m1_case agents-only
  m1_case both
  m1_case import
  m1_case dotclaude
  # The layout of the mikrotik and hermes-fedora-host checkouts: AGENTS.md alone, under a home with a user-level file.
  echo "$marker USERHOME-2d4e" >"$CLAUDE_CONFIG_DIR/CLAUDE.md"
  m1_case home-agents
}

m2() {
  local raw slash result
  bash "$here/model-home.sh" "$PWD"
  mkdir -p /tmp/fx && cd /tmp/fx
  raw=$(claude -p "Reply with the single word OK" --max-turns 1 --max-budget-usd 0.05 --model claude-haiku-5-5 \
    --strict-mcp-config --no-session-persistence --permission-mode dontAsk --output-format stream-json --verbose 2>&1 || true)
  raw=${raw//"$CLAUDE_CODE_OAUTH_TOKEN"/<redacted>}
  slash=$(jq -Rr 'fromjson? | select(.type == "system" and .subtype == "init") | .slash_commands[]' <<<"$raw" | LC_ALL=C sort -u | paste -sd, || true)
  result=$(jq -Rc 'fromjson? | select(.type == "result")' <<<"$raw" | tail -n1 || true)
  echo "m2 slash=${slash:-none} $(status_of "$result")"
}

# m3_found ANSWER: how many of the wanted paths the answer contains.
m3_found() {
  local path found=0
  while IFS= read -r path; do
    if grep -qF -- "$path" <<<"$1"; then found=$((found + 1)); fi
  done <<<"$wanted"
  echo "$found"
}

m3() {
  local question raw_control raw_patched n
  bash /cfg/tests/container/inside/model-home.sh /cfg
  # The backticked paths of the patch's high-risk item, so this script names no private repo's files.
  # shellcheck disable=SC2016 # the backticks are literal text to match, not a command substitution
  wanted=$(sed -nE '/^\+- \*{0,2}High risk/,/^\+- \*{0,2}Reviewer/p' /patch.diff | grep -oE '`[^`]+`' | tr -d '`' |
    grep -E '[./]' | grep -vE '^/| ' | LC_ALL=C sort -u || true)
  n=$(grep -c . <<<"$wanted" || true)
  question="In the project instructions already in this conversation, find the section headed 'Review guidance'. Without using any tool, copy every backticked file path from its high-risk item, one per line, exactly as written, with no other text. If no such section exists, reply NONE."
  raw_control=$(ask "$question")
  git apply /patch.diff
  raw_patched=$(ask "$question")
  echo "m3 wanted=$n control-found=$(m3_found "$(answer_of "$raw_control")") patched-found=$(m3_found "$(answer_of "$raw_patched")") control-$(status_of "$raw_control") patched-$(status_of "$raw_patched")"
}

m4() {
  local raw answer medium=no high=no security=no
  bash "$here/model-home.sh" "$PWD"
  mkdir -p /tmp/fx && cd /tmp/fx
  raw=$(ask "Your global instructions may include a rule about reviewing a change before asking me to commit or push it. Without using any tool, copy the exact review commands that rule requires for a medium-risk change and for a high-risk change, one per line, with no other text. If no such rule exists, reply NONE.")
  answer=$(answer_of "$raw")
  if grep -qF '/code-review medium' <<<"$answer"; then medium=yes; fi
  if grep -qF '/code-review high' <<<"$answer"; then high=yes; fi
  if grep -qF '/security-review' <<<"$answer"; then security=yes; fi
  echo "m4 medium=$medium high=$high security=$security $(status_of "$raw")"
}

case ${1:-} in
  m1 | m2 | m3 | m4) "$1" ;;
  *)
    echo "usage: model-cheap.sh m1|m2|m3|m4" >&2
    exit 2
    ;;
esac
