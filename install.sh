#!/usr/bin/env bash
# install.sh: Idempotently install CLAUDE.md, local skills, bash-guard.sh, the local plugin marketplace, settings.json,
# and plugins into ~/.claude.
#
# Usage: ./install.sh [--host NAME]   (NAME defaults to the short hostname, the host's inside a toolbox; hosts/NAME.json is optional)
#
# Safety order (nothing in ~/.claude is installed until steps 1-3 pass):
#   1. Verify dependencies (jq, python3, cmp, git, GNU grep -P, claude CLI) and that automode/defaults.json
#      matches `claude auto-mode defaults`.
#   2. Self-test the repo's bash-guard.sh (onFailure is "block", so a broken hook must never go live).
#   3. Render settings.json from the shared base plus hosts/NAME.json (hooks/render-settings.py) into a temp file.
#   4. Install bash-guard.sh, CLAUDE.md, local skills (~/.claude/skills), the plugins/ marketplace (~/.claude/marketplace),
#      then settings.json; replaced files are backed up.
#   5. Stop unless claude is logged in, so plugins and verification run only for a logged-in setup. Rerun after `claude auth login`.
#   6. Ensure marketplaces and plugins from settings.json are installed (@builtin plugins need only their settings entry),
#      and update plugins whose installed commit differs from the sha pinned in plugins/.claude-plugin/marketplace.json.
#   7. Verify the effective auto-mode configuration via `claude auto-mode config`.
# ~/.claude means $CLAUDE_CONFIG_DIR when that is set.
set -euo pipefail

host=$(uname -n)
# A toolbox shares $HOME but reports the hostname "toolbx"; use the host's name so its hosts/NAME.json applies.
if [ -f /run/.toolboxenv ] && [ -r /run/host/etc/hostname ]; then
  host=$(< /run/host/etc/hostname)
fi
host=${host%%.*}
while [ $# -gt 0 ]; do
  case $1 in
    --host) [ $# -ge 2 ] || { echo "Error: --host needs a name." >&2; exit 2; }; host=$2; shift 2 ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Error: unknown argument '$1' (usage: ./install.sh [--host NAME])." >&2; exit 2 ;;
  esac
done
host=${host,,}
[[ $host =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "Error: invalid host name '$host' (letters, digits and hyphens only)." >&2; exit 2; }

here=$(cd "$(dirname "$0")" && pwd)
claude_dir=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
hooks_dir=$claude_dir/hooks
skills_dir=$claude_dir/skills
hook_dst=$hooks_dir/bash-guard.sh
test_dst=$hooks_dir/test-bash-guard.sh
claude_md_dst=$claude_dir/CLAUDE.md
settings_dst=$claude_dir/settings.json
marketplace_dst=$claude_dir/marketplace
marketplace_src=$here/plugins/.claude-plugin/marketplace.json
ts=$(date +%Y%m%d%H%M%S)
rendered='' tmp_settings=''
trap 'rm -f ${rendered:+"$rendered"} ${tmp_settings:+"$tmp_settings"}' EXIT

# --- 1. Prerequisite checks ---
# cmp (diffutils) decides "Up to date"; without it every run would back up and reinstall every file.
# git is what `claude plugin marketplace add` clones marketplaces with.
for cmd in jq python3 cmp git claude; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "Error: required command '$cmd' not found in PATH." >&2; exit 1; }
done
printf 'test\n' | command grep -qP 'test' 2>/dev/null || {
  echo "Error: 'grep -P' (PCRE support) is required by bash-guard.sh." >&2
  exit 1
}
# The rendered environment starts from this snapshot, so a stale one would install outdated built-in wording.
live_defaults=$(cd /tmp && claude auto-mode defaults)
jq -e --slurpfile snap "$here/automode/defaults.json" '. == $snap[0]' <<<"$live_defaults" >/dev/null || {
  echo "Error: automode/defaults.json differs from 'claude auto-mode defaults' of $(claude --version)." >&2
  echo "Refresh it as the README's 'Updating autoMode Rules After a Claude Code Upgrade' describes, then rerun." >&2
  exit 1
}

# --- 2. Self-test the repo's hook before anything is installed ---
echo "Running bash-guard self-tests..."
"$here/hooks/test-bash-guard.sh" "$here/hooks/bash-guard.sh"

# --- 3. Render settings.json (shared base + this host's overrides, hook path for this $HOME) ---
host_file=$here/hosts/$host.json
if [ -f "$host_file" ]; then
  echo "Host overrides: hosts/$host.json"
  host_args=("$host_file")
else
  echo "Warning: no hosts/$host.json; installing the shared base only (built-in wording for host slots)." >&2
  host_args=()
fi
rendered=$(mktemp)
python3 -I "$here/hooks/render-settings.py" "$here" "$hook_dst" "$marketplace_dst" "${host_args[@]}" > "$rendered"
jq empty "$rendered"
# Marketplaces and plugins for step 6, read now so a bad entry (or a jq failure, which a process substitution
# would hide) stops the run before anything is installed.
marketplaces=$(jq -r '(.extraKnownMarketplaces // {}) | to_entries[] | .key as $k | .value.source
  | if .source == "github" and .repo then "\($k)\trepo\t\(.repo)"
    elif .source == "directory" and .path then "\($k)\tpath\t\(.path)"
    else error("marketplace \($k): only GitHub (source.repo) and directory (source.path) sources are supported") end' \
  "$rendered")
plugins=$(jq -r '(.enabledPlugins // {}) | to_entries[] | select(.value == true) | .key' "$rendered")
# Commits pinned by the local marketplace, as "plugin@marketplace<TAB>sha", for the update check in step 6.
pins=$(jq -r '.name as $m | .plugins[] | "\(.name)@\($m)\t\(.source.sha // error("plugin \(.name): pin a sha"))"' \
  "$marketplace_src")

# --- 4. Install files ---
ensure_dir() {
  [ -d "$1" ] || install -d -m 0755 "$1"
}

# install_file SRC DST MODE: back up a DST whose content differs, then install SRC there with MODE.
# A DST with the same content but another mode only gets its mode fixed.
install_file() {
  local src=$1 dst=$2 mode=$3
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    if [ "$(stat -c %a "$dst")" = "${mode#0}" ]; then
      echo "Up to date: $dst"
    else
      chmod "$mode" "$dst"
      echo "Set mode $mode: $dst"
    fi
    return
  fi
  if [ -f "$dst" ]; then
    cp -p "$dst" "$dst.bak-$ts"
    echo "Backed up $dst to $dst.bak-$ts"
  fi
  install -m "$mode" "$src" "$dst"
  echo "Installed $dst"
}

ensure_dir "$claude_dir"
ensure_dir "$hooks_dir"
ensure_dir "$skills_dir"
ensure_dir "$marketplace_dst"
ensure_dir "$marketplace_dst/.claude-plugin"
install_file "$here/hooks/bash-guard.sh" "$hook_dst" 0755
install_file "$here/hooks/test-bash-guard.sh" "$test_dst" 0755
install_file "$here/CLAUDE.md" "$claude_md_dst" 0644

# globstar instead of find in a process substitution, whose failure set -e would not see.
shopt -s globstar nullglob dotglob
for src_file in "$here"/skills/**; do
  [ -f "$src_file" ] || continue
  dst_file=$skills_dir/${src_file#"$here/skills/"}
  ensure_dir "$(dirname "$dst_file")"
  mode=0644
  [ -x "$src_file" ] && mode=0755
  install_file "$src_file" "$dst_file" "$mode"
done
shopt -u globstar nullglob dotglob
install_file "$marketplace_src" "$marketplace_dst/.claude-plugin/marketplace.json" 0644

# settings.json keeps its current mode and is replaced atomically.
if [ -f "$settings_dst" ] && cmp -s "$rendered" "$settings_dst"; then
  echo "Up to date: $settings_dst"
else
  tmp_settings=$(mktemp "$claude_dir/settings.json.XXXXXX")
  cp "$rendered" "$tmp_settings"
  if [ -f "$settings_dst" ]; then
    cp -p "$settings_dst" "$settings_dst.bak-$ts"
    echo "Backed up $settings_dst to $settings_dst.bak-$ts"
    chmod --reference="$settings_dst" "$tmp_settings"
  else
    chmod 0644 "$tmp_settings"
  fi
  mv -f "$tmp_settings" "$settings_dst"
  echo "Installed $settings_dst"
fi

# --- 5. Require a logged-in claude for the remaining steps ---
if ! (cd /tmp && claude auth status 2>/dev/null) | jq -e '.loggedIn == true' >/dev/null 2>&1; then
  echo "Files are installed, but claude is not logged in, so plugins and verification were skipped." >&2
  echo "Run 'claude auth login', then rerun ./install.sh to finish." >&2
  exit 3
fi

# --- 6. Ensure configured marketplaces and plugins (read in step 3) are installed ---
known_mp=$claude_dir/plugins/known_marketplaces.json
known_source() { # known_source NAME FIELD: the repo or path marketplace NAME was added from, or nothing
  if [ -f "$known_mp" ]; then jq -r --arg k "$1" --arg f "$2" '.[$k].source[$f] // empty' "$known_mp"; fi
}
while IFS=$'\t' read -r mp_name mp_field mp_from; do
  [ -n "$mp_name" ] || continue
  have=$(known_source "$mp_name" "$mp_field")
  if [ "$have" = "$mp_from" ]; then
    echo "Marketplace already present: $mp_name ($mp_from)"
  elif [ -n "$have" ] || [ -n "$(known_source "$mp_name" source)" ]; then
    echo "Error: marketplace $mp_name was added from ${have:-another kind of source}, but settings.json says $mp_from." >&2
    echo "Remove it with 'claude plugin marketplace remove $mp_name', then rerun." >&2
    exit 1
  else
    echo "Adding marketplace: $mp_name ($mp_from)..."
    claude plugin marketplace add "$mp_from" </dev/null
    [ "$(known_source "$mp_name" "$mp_field")" = "$mp_from" ] || {
      echo "Error: $mp_from was not added as marketplace '$mp_name'; key it in settings.json by the name in its .claude-plugin/marketplace.json." >&2
      exit 1
    }
  fi
done <<<"$marketplaces"

installed_pl=$claude_dir/plugins/installed_plugins.json
installed_sha() { # installed_sha ID: the commit of the user-scope install of plugin ID, or nothing
  jq -r --arg p "$1" '[.plugins[$p][]? | select(.scope == "user") | .gitCommitSha] | first // empty' "$installed_pl"
}
while IFS= read -r plugin_id; do
  [ -n "$plugin_id" ] || continue
  # Built-in plugins ship inside claude and can't be installed; their settings.json entry is what enables them.
  if [[ $plugin_id == *@builtin ]]; then
    echo "Built-in plugin enabled by settings.json: $plugin_id"
  elif [ -f "$installed_pl" ] && jq -e --arg p "$plugin_id" '.plugins[$p] // [] | any(.scope == "user")' "$installed_pl" >/dev/null; then
    echo "Plugin already installed: $plugin_id"
  else
    echo "Installing plugin: $plugin_id..."
    claude plugin install "$plugin_id" </dev/null
  fi
  pin=$(awk -F'\t' -v p="$plugin_id" '$1 == p { print $2 }' <<<"$pins")
  [ -n "$pin" ] || continue
  if [ "$(installed_sha "$plugin_id")" != "$pin" ]; then
    # `claude plugin update` compares plugin.json versions, which a new pin often leaves unchanged, so reinstall.
    echo "Reinstalling plugin $plugin_id at pinned commit $pin..."
    claude plugin uninstall "$plugin_id" --scope user --keep-data </dev/null
    claude plugin install "$plugin_id" --scope user </dev/null
    [ "$(installed_sha "$plugin_id")" = "$pin" ] || {
      echo "Error: $plugin_id is at commit '$(installed_sha "$plugin_id")' after reinstalling, not the pinned $pin." >&2
      exit 1
    }
  fi
done <<<"$plugins"
# A reinstall moves the plugin's enabledPlugins key; put back the rendered file so the next run stays quiet.
if ! cmp -s "$rendered" "$settings_dst"; then
  if jq -e --slurpfile want "$rendered" '. == $want[0]' "$settings_dst" >/dev/null; then
    tmp_settings=$(mktemp "$claude_dir/settings.json.XXXXXX")
    cp "$rendered" "$tmp_settings"
    chmod --reference="$settings_dst" "$tmp_settings"
    mv -f "$tmp_settings" "$settings_dst"
    echo "Restored key order: $settings_dst"
  else
    echo "Warning: claude plugin commands changed $settings_dst; rerun ./install.sh to reinstall the rendered file." >&2
  fi
fi

# --- 7. Verify effective configuration ---
# Each autoMode list must equal the settings.json list with "$defaults" expanded to the built-in rules (step 1
# matched the snapshot to the live ones); a list settings.json leaves out must be the built-in one. soft_deny
# must always be the built-in rules followed by the custom ones, even if "$defaults" went missing.
eff=$(cd /tmp && claude auto-mode config)
bad=$(jq -r --slurpfile want "$settings_dst" --slurpfile d "$here/automode/defaults.json" '
  . as $eff | $want[0].autoMode as $a
  | ("allow", "soft_deny", "hard_deny", "environment") as $k
  | ($a[$k] // ["$defaults"]) as $declared
  | (if $k == "soft_deny" then ["$defaults"] + ($declared - ["$defaults"]) else $declared end) as $expected
  | select($eff[$k] != [$expected[] | if . == "$defaults" then $d[0][$k][] else . end])
  | $k' <<<"$eff")
[ -z "$bad" ] || {
  echo "Error: 'claude auto-mode config' does not match $settings_dst in: ${bad//$'\n'/, }" >&2
  exit 1
}
echo "Verified: $claude_dir setup is active and 'claude auto-mode config' matches."
