"""Render ~/.claude/settings.json from the shared base and an optional per-host file.

Usage: python3 -I hooks/render-settings.py <repo-dir> <hook-path> <marketplace-dir> [<host-file>] > settings.json

Inputs (all in the repo):
  settings.json            every setting except autoMode
  automode/defaults.json   snapshot of `claude auto-mode defaults`
  automode/base.json       slot overrides, extra environment entries and soft_deny shared by every machine
  <host-file>              optional hosts/<name>.json; its slot overrides replace the base ones

environment: the built-in slots in their snapshot wording, with only the overridden slots replaced. No
"$defaults", because a custom entry next to the built-in one for the same slot would contradict it (the
built-in Source control says "no additional orgs"). Override text may use {default} (the built-in slot text
without its trailing period) and {tail} (the built-in rules after "Whatever is configured", used by Host
containment); every other brace is literal. Unknown top-level keys, and {tail} on a slot without that phrase,
are errors.
soft_deny comes from base.json and must start with "$defaults". The Bash|Monitor hook command is set to <hook-path>,
and the path of the one "directory" marketplace in extraKnownMarketplaces to <marketplace-dir>.Output is deterministic, so install.sh can compare it byte for byte.
"""
import json
import pathlib
import re
import sys

TAIL_MARKER = "Whatever is configured"


def load(path, allowed=None):
    data = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    unknown = set(data) - allowed if allowed else set()
    if unknown:
        sys.exit(f"{path}: unknown keys {sorted(unknown)} (allowed: {sorted(allowed)})")
    return data


def slot(entry):
    m = re.match(r"\*\*(.+?)\*\*:\s*", entry)
    return (m.group(1), entry[m.end():]) if m else (None, entry)


def build_environment(defaults, overrides, extra):
    out, used = [], set()
    for entry in defaults:
        label, text = slot(entry)
        if label in overrides:
            used.add(label)
            override = overrides[label]
            at = text.find(TAIL_MARKER)
            if "{tail}" in override and at < 0:
                sys.exit(f"{label}: override uses {{tail}} but the built-in text has no {TAIL_MARKER!r}")
            text = override.replace("{default}", text.rstrip(".")).replace("{tail}", text[at:]).rstrip()
            entry = f"**{label}**: {text}"
        out.append(entry)
    missing = set(overrides) - used
    if missing:
        sys.exit(f"default slots not found (built-in wording changed?): {sorted(missing)}")
    return out + extra


def main():
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__.split("\n\n")[1])
    repo, hook_path, marketplace_dir = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
    settings = load(repo / "settings.json")
    if "autoMode" in settings:
        sys.exit("settings.json must not contain autoMode; it is rendered from automode/ and hosts/")
    defaults = load(repo / "automode" / "defaults.json")
    base = load(repo / "automode" / "base.json", {"environment", "extra_environment", "soft_deny"})
    host = load(sys.argv[4], {"environment"}) if len(sys.argv) == 5 else {}
    if base["soft_deny"][:1] != ["$defaults"]:
        sys.exit('automode/base.json: soft_deny must start with "$defaults", which keeps the built-in rules')

    overrides = {**base["environment"], **host.get("environment", {})}
    settings["autoMode"] = {
        "soft_deny": base["soft_deny"],
        "environment": build_environment(defaults["environment"], overrides, base.get("extra_environment", [])),
    }

    hooks = [h for e in settings.get("hooks", {}).get("PreToolUse", []) if e.get("matcher") == "Bash|Monitor"
             for h in e["hooks"]]
    if len(hooks) != 1:
        sys.exit("settings.json needs exactly one PreToolUse hook with matcher Bash|Monitor")
    hooks[0]["command"] = hook_path

    local = [m["source"] for m in settings.get("extraKnownMarketplaces", {}).values()
             if m.get("source", {}).get("source") == "directory"]
    if len(local) != 1:
        sys.exit('settings.json needs exactly one extraKnownMarketplaces entry with source "directory"')
    local[0]["path"] = marketplace_dir

    sys.stdout.write(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
