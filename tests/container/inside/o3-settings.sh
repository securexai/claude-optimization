#!/usr/bin/env bash
# o3-settings.sh: run inside the test container, from a copy of this repo. Repeats the checks that install.sh makes
# before it installs anything: the auto-mode snapshot matches the claude in the image, and settings.json renders with
# the hook path of the test home.
set -euo pipefail

live=$(cd /tmp && claude auto-mode defaults)
jq -e --slurpfile snap automode/defaults.json '. == $snap[0]' <<<"$live" >/dev/null
echo "auto-mode defaults match the snapshot ($(claude --version))"

hook=$CLAUDE_CONFIG_DIR/hooks/bash-guard.sh
python3 -I hooks/render-settings.py . "$hook" "$CLAUDE_CONFIG_DIR/marketplace" hosts/ai.json >/tmp/settings.json
jq -e --arg hook "$hook" '.hooks.PreToolUse[0].hooks[0].command == $hook' /tmp/settings.json >/dev/null
echo "settings render ok: hook command is $hook"
