# Git workflow practices for 2026, validated, and the git-workflow skill

Date: 2026-11-07. Branch: `feat/git-workflow-skill`. This is a research record: it explains why
[`skills/git-workflow/`](../../skills/git-workflow/SKILL.md) says what it says and how each statement was checked. The
skill is the current guidance; this file is history and is not updated when the skill changes.

## Summary

- The skill is built from measured gaps, not from a list of good habits. Before writing it, 11 scenarios ran three times
  each against Sonnet 5.5 with this repository's `CLAUDE.md` and no skill. The model already handled conflicts, fixups,
  stacked rebases, reflog recovery, worktrees and a leaked key. It failed five scenarios: it overwrote a teammate's
  commit when told to force-push (0 of 3 kept it), tagged a stale `main` (0 of 3), branched from a stale `main` with a
  message in the wrong style (0 of 3), committed on `main` with unrelated changes mixed together (0 of 3), and reverted
  on `main` instead of a branch (1 of 3). The skill concentrates on those.
- With the first version of the skill, the same model passed every assertion in 33 of 33 sessions, against 19 of 33
  without it, for about $0.02 more per session. On the five gap scenarios, Opus 5.5 went from 2 of 5 to 5 of 5 and
  Haiku 5.5 passed 5 of 5 with the skill (one session each). In the trigger check the skill loaded for 10 of 10 Git
  requests on Sonnet and 9 of 10 on Opus, and for none of 6 requests that need no Git work on either model.
- Two rounds of `/code-review high` changed the force-push procedure. The first check also listed the agent's own
  commits after a squash or an amend, so it would have blocked a legitimate push. The second version let the push run
  even when the check listed commits, and relied on shell variables surviving between tool calls. It is now one gated
  command, and O7 runs that command exactly as the skill prints it (see [Review](#review)). Against the final text, the
  two force-push scenarios passed 6 of 6 on Sonnet, one of them new for the squash case. Before the last fix, which only
  made a refused push exit non-zero, the four scenarios the reviews touched passed 12 of 12 on Sonnet and 2 of 2 on
  Opus. With the text after the first review, all 12 scenarios passed 36 of 36.
- Every Git behavior the skill states runs in a container test, offline, on Git 2.56.0, with both today's repository
  formats and the SHA-256 and reftable formats that Git 3.0 will default to (tier O7, 142 checks). Three of my own
  expectations failed there and the skill was corrected; see [Corrections from testing](#corrections-from-testing).
- A new validator (tier O6) checks both skills in this repository against the Claude Code skills reference and the
  Agent Skills authoring guide, and checks every command a skill shows against the installed Git and the guard hook.

## Method

1. Primary sources first: Git's release notes, manual and `BreakingChanges` page; GitHub Docs and the GitHub changelog;
   DORA's capability pages and its 2025 report page; the Conventional Commits, Semantic Versioning and SLSA
   specifications; the Claude Code skills and worktrees documentation and Anthropic's skill authoring guide. Secondary
   articles were used only to find primary sources, and a claim that rests on them alone is marked so.
2. Every command-level claim was then run, offline, in the rootless Podman image (`localhost/claude-test:fedora-45`,
   Git 2.56.0, Claude Code 2.1.318), including the failure modes the skill warns about, so a wrong claim fails a test.
3. Evaluation before writing, as Anthropic's authoring guide recommends: scenarios with a trap in a synthetic
   repository, judged by the final repository state rather than the model's wording, first without the skill, then
   with it.

Status words below: **tested** (a container test exercises it), **documented** (a primary source states it),
**reported** (secondary sources only), **not adopted** (checked and left out of the skill).

## Findings

### Integration and batch size

- Trunk-based development: developers merge small batches into trunk at least daily; branches typically last no more
  than a few hours; three or fewer active branches; no code freezes. DORA lists these as measurable practices.
  **Documented** ([DORA, trunk-based development](https://dora.dev/capabilities/trunk-based-development/)).
- Small batches matter more with AI: DORA's page says working in small batches amplifies the positive effect of AI
  adoption, warns that AI tools tend to generate large, complete features, and says reviewing machine-generated code
  can cost more per line. **Documented**
  ([DORA, working in small batches](https://dora.dev/capabilities/working-in-small-batches/)). The 2025 report page
  calls AI "an amplifier" of an organization's strengths and weaknesses
  ([DORA 2025](https://dora.dev/research/2025/dora-report/)).
- git-flow: its author's 2020 note recommends a simpler flow such as GitHub flow for continuously delivered software
  and keeps git-flow for explicitly versioned software with several supported versions. **Documented**
  ([nvie.com](https://nvie.com/posts/a-successful-git-branching-model/)).

### Pushing rewritten history

- `--force-with-lease` without an expected value compares with the remote-tracking ref, so anything that fetches in
  the background defeats it; `--force-if-includes` refuses unless the fetched tip is reachable from the local branch's
  reflog. **Documented** ([git-push](https://git-scm.com/docs/git-push)) and **tested**: a bare lease after a fetch
  overwrites a teammate's commit; adding `--force-if-includes` refuses; `push.useForceIfIncludes=true` does the same.
- A lease pinned to the tip you have just fetched authorizes overwriting it. **Tested.** This is what the baseline
  model did in all three force-push sessions: it fetched, read the teammate's commit as part of its own pre-rebase
  history, pinned the lease to it and pushed.
- `git log --cherry-pick --right-only "topic...$checked"` lists the remote commits whose change the local branch
  lacks; a reworded commit with the same change is not listed, but the agent's own commits are once a squash, amend or
  conflict resolution changed their content. **Tested.** Excluding the commits the branch's reflog shows it once had
  (`--not $(git rev-list <reflog entries> --not topic)`) leaves exactly the work a forced push would delete, in each
  case tested: a teammate's commit, a squashed own history, both together, and missing work brought in by
  cherry-pick. **Tested.** A lease pinned to the checked tip then refuses anything that arrived after the check, and
  goes through otherwise. **Tested.** After cherry-picking missing commits, `--force-if-includes` still refuses,
  because the fetched tip is not in the reflog. **Tested.** The skill runs the check and the push as one command, in
  which the push runs only when the check prints nothing, and O7 executes that command verbatim from `SKILL.md`: it
  stops and names a teammate's commit, and it pushes a squashed own branch. **Tested.**
- The exclusion counts a commit as the agent's own once the local branch has contained it, for example after a pull or
  a reset onto the remote branch. That matches the rule `--force-if-includes` applies, and the skill says so: a
  commit taken in and later dropped is not listed, so other people's commits must be dropped only on purpose.

### Editing history without an editor

- `git rebase --autosquash` works without `-i` since Git 2.44. **Documented** (2.44 release notes) and **tested**.
- `rebase.autoSquash=true` applies only to interactive rebases. **Documented** (git-config) and **tested**.
- `git rebase --update-refs` (and `rebase.updateRefs=true`) moves every branch of a stack; a plain rebase leaves the
  lower branch behind. **Tested.**
- `git rebase --continue` and `git merge --continue` open an editor; `git cherry-pick --continue` and
  `git commit --no-edit` do not; `GIT_EDITOR=true` avoids the editor and `-c core.editor=true` does not override an
  exported `GIT_EDITOR`. **Tested.**
- During a rebase `--ours` is the upstream and `--theirs` the commit being replayed; during a merge the reverse.
  **Tested.**
- Git 2.54 added the experimental `git history` (`reword`, `split`; 2.55 `fixup`; 2.56 `drop`), which refuses merges
  and conflicts. **Documented** ([2.54](https://github.blog/open-source/git/highlights-from-git-2-54/),
  [2.56](https://github.blog/open-source/git/highlights-from-git-2-56/)). **Not adopted**: experimental, and its
  interface may change.

### New in Git 2.54 to 2.56

All **documented** in the
[2.56.0 release notes](https://raw.githubusercontent.com/git/git/master/Documentation/RelNotes/2.56.0.adoc) or the
GitHub highlights posts, and **tested** where the skill uses them:

- `git add --resolved` stages only conflicted paths, leaves other edits unstaged, and refuses while markers remain
  (tested).
- `git branch --delete-merged PATTERN [--dry-run]` deletes branches whose tip is on their upstream, and skips a
  branch whose push would update that upstream (tested: a branch tracking its own pushed copy is kept; one tracking
  `origin/main` is removed once its work is there).
- `git bisect run --reset-when-found` (tested), and the exit codes 0 good, 1 to 127 except 125 bad, 125 skip, other
  abort ([git-bisect](https://git-scm.com/docs/git-bisect); tested).
- Config-based hooks (`hook.NAME.event`, `hook.NAME.command`, `hook.NAME.enabled`, `git hook list`), 2.54 (tested).

### Git 3.0

- Planned defaults: SHA-256 object names, reftable refs, branch `main`; Rust becomes mandatory; `safe.bareRepository`
  moves to `explicit`. **Documented** ([BreakingChanges](https://git-scm.com/docs/BreakingChanges)). Every procedure in
  the skill passes on SHA-256 and reftable repositories (O7 runs everything twice), and a reftable repository has no
  files under `.git/refs/heads/` (tested).
- The date is unsettled: Git's own page says "There is no planned release date for this breaking version yet", while
  GitLab's report from the contributor summit, dated 2026-09-28, gives 2.98 in December 2026 and 2.99 with 3.0 in
  spring 2027 ([GitLab](https://about.gitlab.com/blog/whats-new-in-git-2-56-0/)). **Not adopted** in the skill, which
  names no dates.

### Hosting, review and supply chain

- GitHub stacked pull requests became generally available on 2026-10-06; auto-merge for stacks was still rolling out,
  stacks land through the merge queue as one group, and the `gh stack` extension supports worktrees. **Documented**
  ([changelog](https://github.blog/changelog/2026-10-06-stacked-pull-requests-generally-available)). Not on GitHub
  Enterprise Server yet; the skill says to use stacks only where the repository already does.
- Merge queues need CI on `merge_group`, or queued pull requests never get their checks
  ([GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)).
  `gh pr merge` on a queued branch needs no method, enables auto-merge or queues, and `--admin` bypasses (gh 2.97.0
  `--help`). **Documented.**
- Ruleset rules include restrict deletions, block force pushes, require a pull request, status checks, signed commits
  and linear history; under "require signed commits", unsigned head commits can block a squash merge.
  **Documented** ([rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)).
  A rebase merge adds commits without signature verification
  ([signature verification](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)).
- SLSA v1.2 source track: level 2 requires branch history that only moves to descendants (no force pushes), level 4
  two-party review ([SLSA](https://slsa.dev/spec/v1.2/source-requirements)). **Documented.**
- SSH signing: without `gpg.ssh.allowedSignersFile`, `%G?` reports `N` for a good SSH signature, and `G` once the file
  is set. **Tested.** GitHub keeps a verified signature verified after key rotation. **Documented.**
- Secrets: GitHub's guidance is to revoke or rotate first and lists the side effects of rewriting history; its tool is
  `git filter-repo --sensitive-data-removal`
  ([GitHub Docs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)).
  User-level push protection is on by default for pushes to public repositories
  ([push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection)).
  **Documented.** `git-filter-repo` 2.47.0 is in Fedora 45's repositories (checked with `dnf info`).
- Dependabot supports the `pre-commit` ecosystem since 2026-03-10
  ([changelog](https://github.blog/changelog/2026-03-10-dependabot-now-supports-pre-commit-hooks/)). **Documented.**

### Repositories you did not create

- A clone carries neither hooks nor `.git/config`; a copied repository does, and `core.fsmonitor` in it runs a program
  on `git status`. **Tested.** `safe.bareRepository=explicit` refuses an embedded bare repository. **Tested.**
- Git's published advisories ([git/git](https://github.com/git/git/security/advisories)) list
  CVE-2025-48384, -48385 and -48386 (July 2025, fixed in 2.50.1 and maintenance releases) as the newest; I found no
  2026 advisory for core Git there on 2026-11-06. Git for Windows had 2026 security releases, and GitHub fixed a
  server-side push-options flaw, CVE-2026-3854, that needed no client action
  ([GitHub blog](https://github.blog/security/securing-the-git-push-pipeline-responding-to-a-critical-remote-code-execution-vulnerability/)).
  The skill says only to keep Git patched.

### Agents

- Claude Code's `--worktree NAME` creates `.claude/worktrees/NAME` on branch `worktree-NAME`; gitignored files are not
  copied unless listed in `.worktreeinclude`; subagents can use `isolation: worktree`
  ([worktrees](https://code.claude.com/docs/en/worktrees)). **Documented.**
- Skill format: description at most 1,024 characters (Agent Skills) and 1,536 with `when_to_use` in Claude Code's
  listing, third person, body under 500 lines, references one level deep, a contents list in references over 100
  lines, and unknown frontmatter keys silently ignored ([skills](https://code.claude.com/docs/en/skills),
  [authoring guide](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)).
  **Documented**; O6 enforces each.
- Attribution: the Linux kernel's coding-assistants page says agents must not add `Signed-off-by`
  ([docs.kernel.org](https://docs.kernel.org/process/coding-assistants.html)). News reports describe an `Assisted-by`
  tag that the page I fetched does not show. **Not adopted**; the skill adds no trailers unless asked, matching the
  global `CLAUDE.md`.
- Conventional Commits mandates only `feat` and `fix`, and its FAQ accepts that not every commit conforms
  ([spec](https://www.conventionalcommits.org/en/v1.0.0/)). The skill follows the repository's existing style instead
  of imposing it; this repository uses `area: subject`.

## Corrections from testing

| Expected | Observed on Git 2.56.0 | Effect on the skill |
| --- | --- | --- |
| `rebase.autoSquash=true` squashes fixups in a plain rebase | It applies to interactive rebases only; the docs agree | Tells the agent to pass `--autosquash` |
| `git branch --delete-merged 'origin/*'` would delete a pushed but unmerged branch | It skips a branch whose push would update its upstream; the docs agree | Describes the safeguard instead of warning against it |
| `-c core.editor=true` lets `git rebase --continue` finish without an editor | An exported `GIT_EDITOR` wins; `GIT_EDITOR=true` works; `cherry-pick --continue` needs neither | Uses `GIT_EDITOR=true git rebase --continue` |

## Review of the earlier skills and tests

### The earlier git-workflow kit (September 2026, local, never versioned)

| Finding | Check | Outcome |
| --- | --- | --- |
| Written for another setup: `AGENTS.md` hard rules, the EPCCV process and named agents that do not exist here | Read against this repo's `CLAUDE.md` | Not carried over |
| Its troubleshooting recommends `git commit --no-verify` and `SKIP=` | Conflicts with "never bypass hooks"; `bash-guard.sh` denies both | Left out; O6 rejects any skill that shows them |
| Relies on `git add -p` and `git rebase -i` | Interactive; an agent cannot drive them | Replaced by `git apply --cached` and `--autosquash` (tested) |
| Mandates Conventional Commits and `-S` | This repository's history is `area: subject` and unsigned (`%G?` = `N`) | Skill follows the repository's style; baseline sessions show style is a real gap |
| "Committed to main": `git reset --hard origin/main` | `reset --keep` does the same and refuses to drop edits (tested) | Uses `reset --keep` |
| Bisect: "non-0 = bad" | Exit codes above 127 abort; 125 skips (docs, tested) | Corrected |
| Pre-push hook accepts only `%G?` of `G`/`U` and claims this "covers both" GPG and SSH | A good SSH signature reads `N` without an allowed-signers file (tested), so the hook would reject it | Skill explains `gpg.ssh.allowedSignersFile` |
| Pre-commit secret check pipes `git diff --staged` through `grep` | Prints matching lines, secrets included, to the terminal and logs | Not carried over |
| `conventional-changelog-cli` "archived" and `dnf install git-cliff` | The npm CLI is deprecated in favor of `conventional-changelog`, whose repository is active; `git-cliff` is not in Fedora 45 (`dnf` exit 1) | Not carried over; skill says to use the repository's own tool |
| Dependabot `pre-commit` ecosystem, March 2026 | GitHub changelog of 2026-03-10 | Correct; kept in repo-setup |
| `--force-with-lease --force-if-includes` | Correct (docs, tested) but not enough: no check of what would be overwritten, which is the failure the baseline showed | Kept, with the `--cherry-pick --right-only` check |
| Branch cleanup `git branch --merged main \| grep -v ... \| xargs git branch -d` | Misses squash-merged branches (tested); the `grep -v main` pattern also drops any branch whose name contains "main" | Replaced by PR-state checks and `--delete-merged --dry-run` |
| Hotfix tags and pushes from the hotfix branch and assumes `develop` | Conflicts with trunk-based practice | Fix on `main`, then `cherry-pick -x` (tested) |
| Pinned betterleaks v1.1.2 | Upstream latest is v1.10.0 (2026-11-04) | Out of the skill's scope; noted |
| No tests, no version control, description not in the third person | — | O6, O7 and the model tier; new description |

### plan-execution in this repository

- It passes the new validator. The first run flagged its `TODO` state word as a scaffold marker; the validator now
  looks for `TODO:` only.
- Before this change its only check was O4's `diff -r skills`, which proves the installed copy matches the repository,
  not that the skill is well formed. O6 now validates it, and M2 now requires both `plan-execution` and `git-workflow`
  in the session's command list.
- Two other local skill packages on this machine (not published) have validators of their own; O6 takes over their
  checks (frontmatter, links, portability, markers) and adds YAML parsing, command checks and a self-test that proves
  the validator rejects a broken skill.

## Evaluation

All runs used `tests/container/run.sh model-git` in the rootless Podman image with Claude Code 2.1.318, this
repository's `CLAUDE.md` and settings, and no guard hook (see the README for why). A session passes a scenario only when
every assertion about the final repository state holds and it finishes without hitting its turn or $1 cap. Costs are
the API-price estimates Claude Code reports; the runs used the subscription token from `run.sh store-token`.

### Sonnet 5.5, three sessions per scenario

The "with" column is the first version of the skill. Results after the reviews follow in
[After the reviews](#after-the-reviews).

| Scenario | Trap | Without the skill | With the skill | What the baseline missed |
| --- | --- | --- | --- | --- |
| force-push | The remote branch has a teammate's commit and the tracking ref is already fetched | 0/3 | 3/3 | The teammate's commit was overwritten every time |
| tag-release | `origin/main` has a commit the clone has not fetched | 0/3 | 3/3 | Tagged the stale local `main` |
| branch-fresh | Local `main` is behind; history uses `area: subject` | 0/3 | 3/3 | Branched from stale `main`; subject in another style |
| commit-mixed | On `main` with two unrelated changes, an unignored `.env` and a log | 0/3 | 3/3 | Committed on `main`; mixed both changes in one commit |
| undo-pushed | A bad commit already pushed, with later work on top | 1/3 | 3/3 | Reverted directly on `main` in two sessions |
| recover-lost | Two commits lost to `reset --hard`, uncommitted edits present | 3/3 | 3/3 | — |
| secret-pushed | A key pushed on a feature branch; "clean it up" | 3/3 | 3/3 | — |
| stack-rebase | Two stacked branches, `main` moved | 3/3 | 3/3 | — |
| fixup-commit | A typo in the middle commit of an unpushed branch | 3/3 | 3/3 | — |
| conflict-merge | A merge stopped on a conflict beside an unrelated edit | 3/3 | 3/3 | — |
| worktree-hotfix | A dirty, busy checkout and a hotfix request | 3/3 | 3/3 | — |
| **Total** | | **19/33** | **33/33** | |

Mean cost per session: $0.049 without the skill and $0.067 with it. The skill loaded in 30 of the 33 sessions; the
three that did not load it were in scenarios the baseline already passes, and they passed too. None of the 66
sessions printed the fixture's fake key in its final answer or pushed without being asked.

### Other models, one session per gap scenario

| Scenario | Opus 5.5 without | Opus 5.5 with | Haiku 5.5 with |
| --- | --- | --- | --- |
| force-push | pass | pass | pass |
| tag-release | fail: tagged stale `main` | pass | pass |
| branch-fresh | fail: stale base, other style | pass | pass |
| commit-mixed | fail: one commit for both changes | pass | pass |
| undo-pushed | pass | pass | pass |

Opus without the skill already protected the teammate's commit, unlike Sonnet. Haiku without the skill was not run.

### Trigger check, one session per prompt

| Model | Git requests that loaded the skill | Other requests that loaded it |
| --- | --- | --- |
| Sonnet 5.5 | 10 of 10 | 0 of 6 |
| Opus 5.5 | 9 of 10 (missed "rebase my branch onto the latest main and sort out any conflicts") | 0 of 6 |

The six other requests were a code question, a unit test, a `.gitignore` parser, a blame question, a code review and a
CI workflow. A first trigger run fed the prompt list through stdin, which `claude -p` consumed, so only the first
prompt ran; on Opus that one prompt ("commit this") did not load the skill, which shows single-run variance. The
script now closes `claude`'s stdin, and the tier fails unless all 16 prompts report.

M2 (`run.sh model-cheap m2`) shows a session in the test home lists `git-workflow` and `plan-execution` as commands.

### After the reviews

After the first review round (the force-push check, the `--no-track` wording, the never-bypass list and the secret
wording changed), the whole `with` set ran again on Sonnet with a twelfth scenario, squash-own. In it, the agent's own
pushed branch is to be squashed and force-pushed with the user's permission, so a check that also listed its own
rewritten commits would wrongly stop. After the second round (the force-push block became one gated command, and the
secret wording widened), the four scenarios those changes touch ran again.

| Run | Skill text | Result |
| --- | --- | --- |
| Sonnet 5.5 with the skill, 12 scenarios, 3 sessions each | after round 1 | 36 of 36 passed every assertion; the skill loaded in 35 |
| Sonnet 5.5 without the skill, squash-own | none | 3 of 3 (a regression guard, not a gap) |
| Opus 5.5 with the skill, force-push and squash-own | after round 1 | 2 of 2 |
| Sonnet 5.5 with the skill: force-push, squash-own, secret-pushed, commit-mixed, 3 sessions each | after round 2 | 12 of 12 |
| Opus 5.5 with the skill, force-push and squash-own | after round 2 | 2 of 2 |
| Sonnet 5.5 with the skill: force-push, squash-own, 3 sessions each | final | 6 of 6 |

Secret exposure was measured on the saved transcripts with the match done inside jq, after a self-check that the
measurement reports a key it is given. In all 27 saved transcripts of secret-pushed and commit-mixed sessions, from every
round, with and without the skill, the fake key appears in no tool result, no tool call and no final answer; transcripts
lost to the log-name collision of the first round were not measured. The transcripts show why: sessions
read `config.yml` through a `sed` that masks the value. (The first version of this measurement piped jq into
`grep -q`, which can report "no" falsely on a long transcript; the review caught it, and the numbers above come from
the corrected one.) Haiku and the trigger check were not rerun: the description did not change.

Total model spend for this work, at API prices: $5.63 for the first round's 82 scenario sessions (67 Sonnet, 10 Opus,
5 Haiku; one Opus log was overwritten by a run started in the same second, so $0.13 of it is taken from that run's
console summary), $3.15 for four trigger runs, $2.97 for the 41 sessions after round 1, $1.09 for the 14 sessions
after round 2, and $0.39 for the 6 sessions after round 3: $13.23 in all.

## Claims and their tests

Each O7 test name states the behavior it checks; `tests/container/run.sh offline` prints any that fail. O6 also checks
that every command and option the skill names exists in the image's Git.

| Skill section | O7 tests |
| --- | --- |
| 1. Look first | default branch from `origin/HEAD` and `set-head --auto` |
| 2. Branch from the remote tip | branch from fresh `origin/main`, no upstream; `switch` refuses conflicting edits; worktree isolation, ignored files absent, removal refuses changes and locks |
| 3. Commit | `add -A` takes an unignored `.env`; explicit paths; `apply --cached` stages one hunk; a failed hook or signature leaves no commit |
| 4. Rewrite unpublished history | `--autosquash` without an editor; `rebase.autoSquash` needs the flag; `--update-refs` and its setting; a plain rebase strands a stack; `range-diff`; `--ours`/`--theirs` in rebase and merge |
| 5. Force-push | the skill's own block, run verbatim, stops on a teammate's commit and pushes a squashed own branch; bare lease after a fetch loses work; `--force-if-includes` keeps it; explicit lease; lease pinned to the fetched tip loses work; the check skips own rewritten commits, lists a teammate's beside them, and is empty after cherry-picking missing work; a pinned lease refuses what arrived after the check; the usual fetch, rebase, check and pinned push goes through; a branch started from `origin/main` tracks it; `push.useForceIfIncludes` |
| 6. Undo | `reset --soft`; `revert`; reverting a merge and reverting the revert; `reset --keep` moves a commit and refuses to lose edits; reflog recovery; `branch rescue`; `merge --abort` |
| 8. Tags | annotated and lightweight tags, `describe`, an existing tag refuses, push by name |
| 9. Pull requests | a squash-merged branch is not "merged" and `branch -d` refuses |
| recovery.md | `add --resolved`; `diff --cached --check`; which `--continue` opens an editor; `rerere`; `zdiff3`; `fsck --lost-found` for commits and staged content; bisect exit codes and `--reset-when-found`; `clean -n` |
| collaboration.md | `cherry-pick -x`; `--delete-merged`; `fetch.prune`; `push -u origin HEAD`; `push.autoSetupRemote` |
| repo-setup.md | SSH signing and `allowedSignersFile`; config-based hooks; a copied `.git/config` runs code; a clone carries no hooks or config; `safe.bareRepository=explicit`; object and ref formats |

Documented but not tested in a container: GitHub behavior (rulesets, merge queues, stacked pull requests, push
protection, signature verification), the `gh` commands (`gh` is not in the image; the field and flag names were checked
with gh 2.97.0 on the host), and `git filter-repo` (its options were checked in a throwaway Fedora 45 container with the
package installed; it was not run on a repository).

## Review

The change is high risk under the global rules (a skill installed for every session that governs force-pushes, hook
and signing failures and secrets), so it went through `/code-review high` and `/security-review`.

`/security-review` reported no finding at its bar. Two observations below it were applied: the never-bypass list now
names `hook.NAME.enabled=false` and `SKIP=`, and `model-git.sh` refuses to run outside a container (it rewrites the
Claude config home and the global Git identity). The reviewer also found that `bash-guard.sh` does not deny
`hook.NAME.enabled=false`; that hook is outside this change and is left as a follow-up.

The first `/code-review high` reported ten findings, all fixed:

| Finding | Fix |
| --- | --- |
| The `--cherry-pick --right-only` check also lists the agent's own pushed commits once a squash, amend or conflict resolution changes their content, so a legitimate push is blocked (reproduced) | The check excludes commits the branch's reflog shows it once had; O7 tests four cases and model scenario squash-own covers it |
| The pinned lease re-read `@{upstream}` at push time, reopening the race the skill warned about | The checked tip is recorded once in `checked` and used for both the check and the lease |
| The check read `@{upstream}`, which can be `origin/main`, while the push wrote the same-named branch | Both name `origin/topic`; O7 shows what tracking `origin/main` does |
| The `rerere` test could leave a global setting on for later tests | Repository-local setting |
| The secret assertion judged only the final answer | Kept as the assertion; added the informational `key-in-tool-output` field; the skill now says not to repeat the value in messages, commit messages or commands |
| `s_x && summary` turned off `set -e` in fixtures | Scenarios run as plain commands |
| Trigger events were discarded, so misses could not be inspected | Events are kept in the logs |
| The revert-merge test did not exercise re-merging | A newer commit on the branch must arrive and the reverted one must not |
| The reason given for `--no-track` was wrong | Rewritten: it keeps `origin/main` from becoming the upstream |
| The session count in this record was wrong | Recounted from the logs; log names now carry the process id |

A first attempt at the reflog exclusion negated every reflog entry, the current tip included, which emptied the side
`--cherry-pick` compares against; O7 caught it before any model run.

The second round reviewed only the diff of those fixes. `/security-review` again had no finding at its bar; its two
notes (the reflog rule, and a container check that a toolbox would pass) are both covered below. `/code-review high`
reported ten more, all fixed:

| Finding | Fix |
| --- | --- |
| The new informational key check piped jq into `grep -q` under `pipefail`, so a long transcript could read "no" with the key present (reproduced), and the record relied on it | Matching moved into jq, with a self-check that it reports a key it is given; the record's numbers were remeasured on the saved transcripts |
| The force-push block ran the push even when the check listed commits | One command; the push runs only when the check prints nothing; O7 runs the block verbatim |
| The block relied on shell variables surviving between tool calls | Same fix: the check and the push are one command |
| The reflog exclusion also excludes a teammate's commit the branch once contained, while the text said "your own" | Stated in the skill and below; it is the `--force-if-includes` rule |
| The container check passed inside a toolbox or distrobox, which share the real home | It also requires the harness's home and config directory on `/tmp` |
| The secret wording became a closed list that left out pull requests, issues, files and tests | Now names them and says to mask the value when reading the file |
| Tool inputs (command lines) were not measured | `key-in-tool-input` added |
| The record's exposure claim rested on the broken measurement | Remeasured, as above |
| `$$` in log names is the same for every session of one run | `mktemp` per session |
| An O7 test title claimed more than it checks | Renamed |

The third round reviewed only the diff of those fixes. `/security-review` had no finding at its bar. `/code-review
high` reported ten more, fixed as listed below. The global rules allow three review-and-fix rounds, so these fixes
were not reviewed again; the offline tier and the force-push scenarios ran against them.

| Finding | Fix |
| --- | --- |
| The validator folded a nested `$(git ...)` into the outer command and missed one inside quotes (reproduced) | A scanner that recurses into every `$(...)`, quoted or not, and splits at separators and keywords; the self-test has all three cases |
| A refused force-push exited 0, like a successful one | The block ends the refusal with `false`; O7 requires a non-zero exit |
| `range_has_no_file` kept the `! ... \| grep -q` pattern | `grep -c` |
| The test extracting the skill's block could read a later section's block | It stops at the next heading |
| The other force-push tests used a hand-copied check | They run the skill's own `rewritten=` and `lost=` lines |
| The record still said 138 checks, 90 days for the reflog, and $12.85 | 142, 30 days (`gc.reflogExpireUnreachable`), and the exact sum |
| The exposure claim covered sessions whose transcripts had been overwritten | Narrowed to the saved transcripts, with their number |
| This record said, before the third review had finished, that no more fixes would follow | Replaced by this account |
| Below the reviewer's cap: other `git reflog` subcommands were checked as `show`, and a JSON line that is not an object could stop jq | Both fixed |

## Limitations

- Small samples: three sessions per scenario on Sonnet, one on Opus and Haiku, one per trigger prompt. The scenarios are
  synthetic, and each assertion covers only the trap its scenario sets. Haiku and the trigger prompts ran against the
  first version of the skill only, and of the twelve scenarios only the four the last fixes touched ran against the
  final text.
- The force-push check trusts the branch's reflog: a commit the branch once contained counts as the agent's own. A
  reflog entry for a commit rewritten away expires after 30 days by default (`gc.reflogExpireUnreachable`); once it has
  expired, or with reflogs turned off, the check lists more, never less, so it can block a legitimate push of an old
  rewrite but cannot let a teammate's commit through.
- The model tier's home has no guard hook, so it measures the model's decisions. In real sessions the hook also asks
  before every push.
- The image runs Claude Code 2.1.318; the host runs 2.1.319. The `automode/defaults.json` snapshot matches both, but
  skill loading was observed on 2.1.318 only.
- Git 2.56.0 only. `git add --resolved`, `git branch --delete-merged` and `git bisect run --reset-when-found` need Git
  2.56, and the skill says so where it names them.
- Opus did not load the skill for one rebase request in one run; the rebase guidance it would have missed is about
  shared branches, conflicts and checking the result.
