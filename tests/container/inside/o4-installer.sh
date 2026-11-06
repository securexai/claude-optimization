#!/usr/bin/env bash
# o4-installer.sh: run inside the test container, from a copy of this repo, with a CLAUDE_CONFIG_DIR that does not
# exist yet. Runs install.sh twice and checks that
#   - it stops where an offline, logged-out run must: exit 3 at the login check, after step 4 installed the files,
#   - every file it installs matches the repo, and settings.json is exactly what render-settings.py produces,
#   - the installed hook passes its own suite from the place it was installed to,
#   - the second run changes nothing and leaves no backups.
# Prints "O4 OK ..." on success, or "O4 FAIL: reason" and exits 1.
set -euo pipefail
cfg=$CLAUDE_CONFIG_DIR

fail() {
  echo "O4 FAIL: $*"
  exit 1
}
# The claude CLI also keeps its own state in the config directory (a queue of failed telemetry events, .claude.json),
# and that changes between runs. The manifest covers only the paths install.sh installs.
manifest() {
  (cd "$cfg" && find CLAUDE.md settings.json hooks skills marketplace -type f -print0 | sort -z | xargs -0 sha256sum)
}

[ ! -e "$cfg" ] || fail "$cfg exists before the first run"

rc1=0
./install.sh --host ai >/tmp/install-1.log 2>&1 || rc1=$?
manifest >/tmp/manifest-1
rc2=0
./install.sh --host ai >/tmp/install-2.log 2>&1 || rc2=$?
manifest >/tmp/manifest-2

if [ "$rc1" != 3 ]; then
  tail -n 15 /tmp/install-1.log
  fail "the first run exited $rc1, expected 3 (claude is not logged in)"
fi
grep -q 'claude is not logged in' /tmp/install-1.log || fail "the first run did not stop at the login check"
[ "$rc2" = 3 ] || fail "the second run exited $rc2, expected 3"
cmp -s /tmp/manifest-1 /tmp/manifest-2 || fail "the second run changed installed files"
if grep -Eq '^(Installed|Backed up|Removed|Set mode)' /tmp/install-2.log; then fail "the second run reported changes"; fi
[ -z "$(find "$cfg" -name '*.bak-*')" ] || fail "backup files exist after a first install and an unchanged rerun"

cmp -s CLAUDE.md "$cfg/CLAUDE.md" || fail "CLAUDE.md differs from the repo"
cmp -s hooks/bash-guard.sh "$cfg/hooks/bash-guard.sh" || fail "bash-guard.sh differs from the repo"
cmp -s hooks/test-bash-guard.sh "$cfg/hooks/test-bash-guard.sh" || fail "test-bash-guard.sh differs from the repo"
diff -r skills "$cfg/skills" >/dev/null || fail "the installed skills differ from skills/"
cmp -s plugins/.claude-plugin/marketplace.json "$cfg/marketplace/.claude-plugin/marketplace.json" ||
  fail "marketplace.json differs from the repo"
locals=$(jq -r '.plugins[] | select(.source | type == "string") | .name' plugins/.claude-plugin/marketplace.json)
while IFS= read -r plugin; do
  [ -z "$plugin" ] || diff -r "plugins/$plugin" "$cfg/marketplace/$plugin" >/dev/null ||
    fail "local plugin $plugin differs from plugins/$plugin"
done <<<"$locals"
python3 -I hooks/render-settings.py . "$cfg/hooks/bash-guard.sh" "$cfg/marketplace" hosts/ai.json |
  cmp -s - "$cfg/settings.json" || fail "settings.json is not the rendered file"
[ "$(stat -c %a "$cfg/hooks/bash-guard.sh")" = 755 ] || fail "bash-guard.sh is not mode 755"
[ "$(stat -c %a "$cfg/CLAUDE.md")" = 644 ] || fail "CLAUDE.md is not mode 644"

guard=$("$cfg/hooks/test-bash-guard.sh" "$cfg/hooks/bash-guard.sh" | tail -n1)
[[ $guard =~ ^pass=[0-9]+\ fail=0$ ]] || fail "the installed hook fails its own suite: $guard"

echo "home entries: $(find "$HOME" -mindepth 1 -maxdepth 1 -printf '%f ')"
echo "O4 OK files=$(wc -l </tmp/manifest-1) exit=$rc1/$rc2 guard=$guard"
