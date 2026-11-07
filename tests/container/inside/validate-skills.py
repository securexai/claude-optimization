#!/usr/bin/env python3
"""validate-skills.py SKILLS_DIR GUARD_HOOK: check every skill under SKILLS_DIR (one directory per skill).

Format, from the Claude Code skills reference and the Agent Skills authoring guide:
  - SKILL.md opens with YAML frontmatter that parses to a mapping and uses only keys Claude Code knows (it ignores an
    unknown key without an error, so a typo would silently do nothing);
  - name equals the directory, is lowercase letters, digits and single hyphens, at most 64 characters, without the
    reserved words "anthropic" and "claude";
  - description is 1 to 1,024 characters, has no angle brackets, and is written in the third person (it does not open
    with I, You, Use or This); with when_to_use it stays within the 1,536 characters of the skill listing;
  - the body is under 500 lines; every Markdown file of over 100 lines starts with a "Contents" list;
  - relative links resolve inside the skill, reference files link no further than one level, and every bundled file is
    linked from SKILL.md;
  - no machine-specific home paths and no unfinished-work markers.

Commands, for every line in a ```bash block of any Markdown file in a skill:
  - each block parses with `bash -n`;
  - each git command names a real subcommand, and each long option it passes exists in the installed Git (from
    `git <cmd> [<subcmd>] -h`, or for log-like commands by running the options in a scratch repository);
  - the guard hook never denies it, and asks only for a push or a GitHub write;
  - nothing in the deny list below appears, because a skill must not teach what the user's rules forbid.

Prints one line per problem and a final "skills=N commands=M errors=E"; exits 1 when E > 0.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

KNOWN_KEYS = {
    "name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable",
    "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
    "metadata", "license", "compatibility",
}
NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)\)")
# A fence may be indented inside a list item; the indentation is not part of the commands.
FENCE = re.compile(r"^[ \t]*```bash\n(.*?)^[ \t]*```", re.M | re.S)
# Scaffold markers carry a colon ("TODO: write this"); a bare word can be content, such as plan-execution's TODO state.
MARKERS = re.compile(r"\b(TODO|FIXME|XXX|TBD):")
# Inline code that starts with "git " is checked for real subcommands and options too, but not against the deny list,
# because prose names the commands it warns against.
INLINE_GIT = re.compile(r"`(git [^`\n]+)`")
# Commands a skill must never show. The guard hook denies some of these too; this list also covers what it only asks for.
DENY = [
    (re.compile(r"\bgit\b.*\bpush\b.*(\s--force(\s|$)|\s-f(\s|$)|\s\+\S+:)"), "a push with --force, -f or +ref"),
    (re.compile(r"\bgit\s+add\s+(-A|--all|\.)(\s|$)"), "git add -A or git add ."),
    (re.compile(r"\bgit\b.*\s(-i|--interactive|-p|--patch)(\s|$)"), "an interactive option, which an agent cannot drive"),
    (re.compile(r"--no-verify|--no-gpg-sign|commit\.gpgsign=false|core\.hooksPath"), "a hook or signing bypass"),
    (re.compile(r"\breset\s+--hard\b|\bclean\s+-[a-z]*f|checkout\s+--\s+\.|\bbranch\s+-D\b"), "a command that discards work"),
    (re.compile(r"Co-authored-by|Signed-off-by"), "an attribution or sign-off trailer"),
]
# These commands take revision and diff options that `-h` does not list, so their options are tried in a scratch repo.
RUN_TO_CHECK = {"log": ["HEAD"], "show": ["HEAD"], "diff": ["HEAD"], "range-diff": ["HEAD~1", "HEAD~1", "HEAD"],
                "rev-list": ["HEAD"], "shortlog": ["HEAD"], "reflog": ["HEAD"]}
# Shell keywords that start a command position; a word after one of them can be a command name.
KEYWORDS = {"if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!"}
# Installed separately from Git, so the image cannot check them; the skill says so where it names them.
EXTERNAL = {"filter-repo"}

errors: list[str] = []


def error(where: str, message: str) -> None:
    errors.append(f"{where}: {message}")


def split_frontmatter(path: Path) -> tuple[dict, str] | None:
    text = path.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n(.*)\Z", text, re.S)
    if not match:
        error(str(path), "SKILL.md must start with YAML frontmatter between --- lines")
        return None
    try:
        data = yaml.safe_load(match.group(1))
    except yaml.YAMLError as exc:
        error(str(path), f"frontmatter is not valid YAML: {exc}")
        return None
    if not isinstance(data, dict):
        error(str(path), "frontmatter must be a mapping")
        return None
    return data, match.group(2)


def check_frontmatter(skill: Path, data: dict, body: str) -> None:
    where = f"{skill.name}/SKILL.md"
    for key in sorted(set(data) - KNOWN_KEYS):
        error(where, f"unknown frontmatter key '{key}' (Claude Code would ignore it)")
    name = data.get("name")
    if name != skill.name:
        error(where, f"name '{name}' must equal the directory name '{skill.name}'")
    if not isinstance(name, str) or not NAME.match(name) or len(name) > 64:
        error(where, "name must be lowercase letters, digits and single hyphens, at most 64 characters")
    elif re.search(r"anthropic|claude", name):
        error(where, "name must not contain the reserved words anthropic or claude")
    desc = data.get("description")
    if not isinstance(desc, str) or not desc.strip():
        error(where, "description is required")
        return
    if len(desc) > 1024:
        error(where, f"description has {len(desc)} characters; the limit is 1,024")
    if len(desc) + len(str(data.get("when_to_use", ""))) > 1536:
        error(where, "description and when_to_use together exceed the 1,536 characters of the skill listing")
    if "<" in desc or ">" in desc:
        error(where, "description must not contain angle brackets")
    if desc.split()[0] in {"I", "You", "Use", "This"}:
        error(where, "description should be in the third person (what the skill does), not start with I, You, Use or This")
    lines = body.strip().splitlines()
    if not lines:
        error(where, "the body is empty")
    elif len(lines) >= 500:
        error(where, f"the body has {len(lines)} lines; keep it under 500")


def check_files(skill: Path) -> None:
    md_files = sorted(skill.rglob("*.md"))
    skill_mds = [p for p in md_files if p.name == "SKILL.md"]
    if skill_mds != [skill / "SKILL.md"]:
        error(skill.name, f"a skill holds exactly one SKILL.md, at its root; found {[str(p.relative_to(skill)) for p in skill_mds]}")
    linked_from_skill: set[Path] = set()
    for path in md_files:
        rel = path.relative_to(skill)
        text = path.read_text(encoding="utf-8")
        lines = text.splitlines()
        # SKILL.md is itself the overview that points to everything else; the rule is for the files it links.
        if path.name != "SKILL.md" and len(lines) > 100 and not any(re.match(r"^#+\s+Contents\s*$", line) for line in lines[:15]):
            error(f"{skill.name}/{rel}", "a file of over 100 lines needs a 'Contents' list near the top")
        if re.search(r"/(var/)?home/[a-z]", text):
            error(f"{skill.name}/{rel}", "machine-specific home path")
        if MARKERS.search(text):
            error(f"{skill.name}/{rel}", "unfinished-work marker (TODO, FIXME, XXX or TBD)")
        for raw in LINK.findall(text):
            if re.match(r"^[a-z][a-z0-9+.-]*:", raw) or raw.startswith("#"):
                continue
            target = (path.parent / raw.split("#", 1)[0]).resolve()
            if not target.is_relative_to(skill.resolve()):
                error(f"{skill.name}/{rel}", f"link '{raw}' leaves the skill directory")
            elif not target.exists():
                error(f"{skill.name}/{rel}", f"link '{raw}' points to a missing file")
            elif path.name == "SKILL.md":
                linked_from_skill.add(target)
            elif target.suffix == ".md" and target != (skill / "SKILL.md").resolve():
                error(f"{skill.name}/{rel}", f"link '{raw}' goes a second level deep; link it from SKILL.md instead")
    for path in sorted(p for p in skill.rglob("*") if p.is_file() and p.name != "SKILL.md"):
        if path.resolve() not in linked_from_skill:
            error(f"{skill.name}/{path.relative_to(skill)}", "not linked from SKILL.md, so Claude would never load it")


def git_help(words: list[str], scratch: Path) -> str:
    # Inside a repository: some subcommands, such as `git worktree add -h`, print their options only there.
    out = subprocess.run(["git", "-C", str(scratch), *words, "-h"], capture_output=True, text=True)
    return out.stdout + out.stderr


def option_known(help_text: str, option: str) -> bool:
    name = option.split("=", 1)[0][2:]
    plain = name[3:] if name.startswith("no-") else name
    return bool(re.search(rf"--(\[no-\])?{re.escape(name)}\b", help_text) or
                re.search(rf"--(\[no-\]|no-)?{re.escape(plain)}\b", help_text))


def check_git_command(where: str, words: list[str], scratch: Path) -> None:
    i = 1
    while i < len(words) and words[i] in {"-C", "-c"}:
        i += 2
    if i >= len(words):
        error(where, "git without a subcommand")
        return
    sub = words[i]
    rest = words[i + 1:]
    options = [w for w in rest if w.startswith("--") and w != "--"]
    if sub in EXTERNAL:
        return
    # `git reflog show` takes log options; its other subcommands (expire, delete, exists) are checked through their help.
    other_reflog_verb = sub == "reflog" and bool(rest) and rest[0] != "show" and bool(re.match(r"^[a-z]+$", rest[0]))
    if sub in RUN_TO_CHECK and not other_reflog_verb:
        verb = [rest[0]] if sub == "reflog" and rest and rest[0] == "show" else []
        out = subprocess.run(["git", "-C", str(scratch), sub, *verb, *options, *RUN_TO_CHECK[sub]], capture_output=True,
                             text=True)
        if out.returncode != 0:
            first = (out.stderr.strip().splitlines() or ["no message"])[0]
            error(where, f"git {sub} rejects {' '.join(options) or 'its arguments'}: {first}")
        return
    if sub == "rev-parse":
        # rev-parse echoes an option it does not know instead of failing, so a known one must print something else.
        for option in options:
            out = subprocess.run(["git", "-C", str(scratch), "rev-parse", option], capture_output=True, text=True)
            if out.returncode != 0 or option in out.stdout:
                error(where, f"git rev-parse does not know {option}")
        return
    help_text = git_help([sub], scratch)
    if re.search(r"is not a git command", help_text):
        error(where, f"'git {sub}' is not a git command")
        return
    if rest and re.match(r"^[a-z][a-z-]*$", rest[0]):
        help_text += git_help([sub, rest[0]], scratch)
    for option in options:
        if not option_known(help_text, option):
            error(where, f"git {sub} has no option {option.split('=', 1)[0]} in this Git")


def substitutions(text: str) -> tuple[str, list[str]]:
    """TEXT with each outermost $(...) replaced by one placeholder word, and the texts inside them, quoted or not."""
    outer, inner, i = [], [], 0
    while i < len(text):
        if not text.startswith("$(", i):
            outer.append(text[i])
            i += 1
            continue
        depth, j = 1, i + 2
        while j < len(text) and depth:
            if text[j] == "(":
                depth += 1
            elif text[j] == ")":
                depth -= 1
            j += 1
        inner.append(text[i + 2:j - 1])
        outer.append("SUBSTITUTION")
        i = j
    return "".join(outer), inner


def git_commands(line: str) -> list[list[str]]:
    """Every git command in a shell line: its own words, without those of any $(...) inside it, plus each git command
    inside those substitutions. Commands split at ; && || | and at keywords such as then and else; an environment
    assignment before a command is dropped. Raises ValueError for text shlex cannot split."""
    outer, inner = substitutions(line)
    found = [command for text in inner for command in git_commands(text)]
    lexer = shlex.shlex(outer, posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    segment: list[str] = []
    for word in [*lexer, ";"]:
        if set(word) <= set(";&|()<>") or word in KEYWORDS:
            while segment and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", segment[0]):
                segment = segment[1:]
            if segment and segment[0] == "git":
                found.append(segment)
            segment = []
        else:
            segment.append(word)
    return found


def guard_decision(hook: Path, command: str) -> str:
    out = subprocess.run([str(hook)], input=json.dumps({"tool_input": {"command": command}}), capture_output=True,
                         text=True)
    if out.returncode != 0:
        return "error"
    if not out.stdout.strip():
        return "allow"
    return json.loads(out.stdout)["hookSpecificOutput"]["permissionDecision"]


def check_commands(skill: Path, hook: Path, scratch: Path) -> int:
    count = 0
    for path in sorted(skill.rglob("*.md")):
        rel = f"{skill.name}/{path.relative_to(skill)}"
        text = path.read_text(encoding="utf-8")
        for span in INLINE_GIT.findall(text):
            try:
                commands = git_commands(span)
            except ValueError as exc:
                error(f"{rel}: {span}", f"cannot split into words: {exc}")
                continue
            count += 1
            for words in commands:
                check_git_command(f"{rel}: {span}", words, scratch)
        for block in FENCE.findall(text):
            parsed = subprocess.run(["bash", "-n"], input=block, capture_output=True, text=True)
            if parsed.returncode != 0:
                error(rel, f"a bash block does not parse: {parsed.stderr.strip()}")
            for line in block.splitlines():
                command = line.split(" # ", 1)[0].strip()
                if not command or command.startswith("#"):
                    continue
                count += 1
                where = f"{rel}: {command}"
                for pattern, why in DENY:
                    if pattern.search(command):
                        error(where, f"shows {why}")
                decision = guard_decision(hook, command)
                if decision == "deny" or decision == "error":
                    error(where, f"the guard hook answers {decision}")
                elif decision == "ask" and not re.search(r"\bgit\b.*\bpush\b|\bgh\s", command):
                    error(where, "the guard hook asks for a command that is neither a push nor a GitHub write")
                try:
                    commands = git_commands(command)
                except ValueError as exc:
                    error(where, f"cannot split into words: {exc}")
                    continue
                for git_words in commands:
                    check_git_command(where, git_words, scratch)
    return count


def check_rejects_a_broken_skill(hook: Path, scratch: Path) -> None:
    """Self-test: a skill with known defects must produce every expected error, or this validator proves nothing."""
    global errors
    kept, errors = errors, []
    with tempfile.TemporaryDirectory() as tmp:
        bad = Path(tmp) / "bad-skill"
        (bad / "references").mkdir(parents=True)
        (bad / "SKILL.md").write_text(
            "---\nname: Bad_Skill\ndescription: Use this <now>\ncolour: red\n---\n\n# Bad\n\nSee [gone](references/gone.md).\n\n"
            "```bash\ngit push --force origin main\ngit commit --no-verify -m x\ngit rebase --no-such-option main\n"
            "git log --no-such-format\ngit rev-parse --show-no-such-thing\n"
            "x=$(git reflog show --no-such-reflog-option topic) && if true; then git fetch --no-such-fetch-option; fi\n"
            "y=\"$(git rev-parse --no-such-quoted-option)\"\n"
            "git log $(git rev-parse --show-toplevel) --oneline\n"
            "git reflog expire --expire=now --all\n"
            "```\n\n1. Step:\n\n   ```bash\n   git push -f origin main\n   ```\n",
            encoding="utf-8")
        (bad / "references" / "orphan.md").write_text("TODO: write\n", encoding="utf-8")
        split = split_frontmatter(bad / "SKILL.md")
        if split:
            check_frontmatter(bad, *split)
        check_files(bad)
        check_commands(bad, hook, scratch)
    found, errors = errors, kept
    if not any("git push -f origin main" in line and "a push with --force" in line for line in found):
        error("self-test", "a command in an indented fence was not checked")
    # Correct commands must not be reported: a nested command's options belong to it, not to the outer one.
    for innocent in ("--show-toplevel", "--expire"):
        if any(innocent in line.split(": ")[-1] for line in found):
            error("self-test", f"a correct command was reported for {innocent}")
    expected = ["unknown frontmatter key 'colour'", "must equal the directory name", "angle brackets", "third person",
                "points to a missing file", "not linked from SKILL.md", "unfinished-work marker", "a push with --force",
                "the guard hook answers deny", "has no option --no-such-option", "git log rejects --no-such-format",
                "git rev-parse does not know --show-no-such-thing", "git reflog rejects --no-such-reflog-option",
                "has no option --no-such-fetch-option", "git rev-parse does not know --no-such-quoted-option"]
    for want in expected:
        if not any(want in line for line in found):
            error("self-test", f"a broken skill did not produce '{want}'")


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.splitlines()[0], file=sys.stderr)
        return 2
    skills_dir, hook = Path(sys.argv[1]), Path(sys.argv[2])
    skills = sorted(p for p in skills_dir.iterdir() if p.is_dir())
    commands = 0
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        env_id = ["-c", "user.name=v", "-c", "user.email=v@example.invalid"]
        subprocess.run(["git", "init", "--quiet", str(scratch)], check=True)
        for msg in ("one", "two"):
            subprocess.run(["git", "-C", str(scratch), *env_id, "commit", "--quiet", "--allow-empty", "-m", msg], check=True)
        check_rejects_a_broken_skill(hook, scratch)
        for skill in skills:
            if not (skill / "SKILL.md").is_file():
                error(skill.name, "no SKILL.md")
                continue
            parsed = split_frontmatter(skill / "SKILL.md")
            if parsed:
                check_frontmatter(skill, *parsed)
            check_files(skill)
            commands += check_commands(skill, hook, scratch)
    for line in errors:
        print(f"ERROR {line}")
    print(f"skills={len(skills)} commands={commands} errors={len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
