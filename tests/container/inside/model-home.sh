#!/usr/bin/env bash
# model-home.sh REPO_DIR: run inside the test container. Builds the model tiers' test home in $CLAUDE_CONFIG_DIR from a
# copy of this repo: CLAUDE.md, the guard hook, the skills and the rendered settings, without the plugin keys and with
# the test home's own default model and effort levels (below).
# It does not use install.sh: with a token in the environment its login check passes, and it would go on to fetch
# marketplace plugins from GitHub. Rerunning it converges on the same home.
# Effort levels in the test home are set here, not taken from settings.json, so a change to your own model or effort
# settings never changes what the model tiers measure or what their caps were set for. They are the levels
# settings.json gave when the results in docs/research were recorded (commit b75f1b1): Opus medium, Haiku xhigh, and
# no entry for Sonnet, which runs at the default effort of the image's pinned Claude Code version (O1 checks that
# version). The default model is Haiku as a safety net: every session passes --model, and one that did not should
# fall back to the cheapest model, not to the account's default.
set -euo pipefail
src=$1
cfg=$CLAUDE_CONFIG_DIR

mkdir -p "$cfg/hooks" "$cfg/skills"
install -m 644 "$src/CLAUDE.md" "$cfg/CLAUDE.md"
# A draft of the global rules, mounted by run.sh from COTEST_CLAUDE_MD, is tried here without changing the repo's file.
if [ -f /rule-draft.md ]; then install -m 644 /rule-draft.md "$cfg/CLAUDE.md"; fi
install -m 755 "$src/hooks/bash-guard.sh" "$cfg/hooks/bash-guard.sh"
cp -rT "$src/skills" "$cfg/skills"
python3 -I "$src/hooks/render-settings.py" "$src" "$cfg/hooks/bash-guard.sh" "$cfg/marketplace" "$src/hosts/ai.json" |
  jq 'del(.enabledPlugins, .extraKnownMarketplaces) | .model = "claude-haiku-5-5" |
    .modelSettings = {"claude-opus-5-5": {"effortLevel": "medium"}, "claude-haiku-5-5": {"effortLevel": "xhigh"}}' >"$cfg/settings.json"
