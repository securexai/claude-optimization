---
name: git-workflow
description: Keeps an agent's Git work safe and reviewable - starting branches from the current remote tip, committing one change at a time in the repository's own style, rewriting only unpublished history, force-pushing without overwriting other people's commits, tagging what the remote has, and undoing or recovering commits. Use before running Git commands that change state (commit, branch, switch, merge, rebase, push, tag, revert, reset, cherry-pick, worktree), including short requests such as "commit this", "push it", "force it", "tag a release" or "undo that", and when a secret may have been committed. Not for read-only questions about history, code review, or CI configuration.
---

# Git workflow

Agents rarely lose work through Git itself. They lose it by acting on a stale picture of the remote, by committing on the wrong branch, or by forcing past a check. The steps below close those gaps. They grant no permission: commits, pushes, tags and branches that leave the machine, rewrites of published history, and deletions still need whatever the user's and the repository's instructions require.

Examples use `origin` and `main`. Use the repository's own remote and default branch: `git symbolic-ref --short refs/remotes/origin/HEAD` prints it, and `git remote set-head origin --auto` repairs it when missing.

## 1. Look first

Before the first change in a repository, and again before any push or tag:

```bash
git status --short --branch
git fetch --prune origin
git log --oneline -15
```

- `status` shows the branch, how far it is ahead of or behind its upstream, uncommitted and untracked files, and any rebase, merge, cherry-pick or bisect in progress. Finish or abort an operation in progress before starting another.
- `fetch` makes `origin/main` current. Local `main` can be behind it, so never base new work, a tag or a force-push decision on local `main` without fetching first.
- `log` shows how this repository writes commit messages. Also follow its CONTRIBUTING file, commit-lint or pre-commit configuration and pull request template when present.

## 2. Work on a branch that starts at the remote tip

- Do not commit on the default branch, a release branch or someone else's branch unless the user asks for exactly that. This includes reverts and one-line fixes. Create a branch first; uncommitted changes come along.
- Start new work from the fetched tip, not from local `main`:

```bash
git switch -c topic origin/main --no-track
```

- `--no-track` keeps `origin/main` from becoming the branch's upstream. With it as upstream, `git status` reports against `main`, a plain `git push` refuses because the names differ, and anything that reads `@{upstream}` looks at `main`. Publish with `git push -u origin HEAD`, which makes the branch's own remote copy its upstream. If uncommitted changes conflict with the newer tip, `git switch` refuses and changes nothing; commit them or set them aside first.
- Name branches like the repository's existing ones (`git branch -r`), otherwise `type/short-topic`.
- To work beside a checkout that must not change (a running test, another agent, uncommitted work), add a worktree instead of stashing or switching:

```bash
git worktree add ../repo-hotfix -b hotfix origin/main --no-track
```

- A new worktree has no gitignored files such as `.env`. Remove it with `git worktree remove ../repo-hotfix` when done; that refuses while it holds uncommitted or untracked files.

## 3. Commit one change at a time, in the repository's style

Stage explicit paths, then read exactly what will be committed:

```bash
git add -- path/one path/two
git diff --cached --stat
git diff --cached
```

- `git add -A` and `git add .` also take untracked files, including an unignored `.env`, logs and build output. Leave those out and say so in the report.
- Put unrelated changes in separate commits; a subject that needs "and" or a semicolon is two commits. To stage part of a file without an interactive prompt, save the wanted hunks as a patch and run `git apply --cached --recount part.diff`.
- Write the message the way recent commits are written. Use Conventional Commits only if the repository already does. Write the subject in the imperative, about 50 to 72 characters, and add a body that says why when the reason is not obvious.
- Add no trailers (`Co-authored-by`, `Signed-off-by`, generated-by notes) unless the user or the repository asks, and never sign off on a person's behalf.
- When a hook or signing fails, no commit was made. Fix the cause and commit again. Never get past the failure by skipping or switching off hooks or signing (`--no-verify`, `-n`, `core.hooksPath`, `hook.NAME.enabled=false`, `SKIP=`, `--no-gpg-sign`, `-c commit.gpgsign=false`); report it instead.

## 4. Rewrite only unpublished history

- A commit is published once it is on a remote branch that others can fetch. Fix published commits with a new commit or `git revert`; amend, fix up or rebase only commits nobody else has.
- To change an earlier unpushed commit without an editor:

```bash
git commit --fixup=SHA
git rebase --autosquash origin/main
```

- `--autosquash` works without `-i` on Git 2.44 and later, but the `rebase.autoSquash` setting applies only to interactive rebases, so pass the flag. For stacked branches add `--update-refs`, which moves every branch in the stack. Compare before and after with `git range-diff origin/main ORIG_HEAD HEAD`.
- Bring a shared branch up to date with a merge; rebase only branches that are yours alone.
- In a conflict, during a rebase `--ours` is the branch you are rebasing onto and `--theirs` is your own commit; during a merge it is the other way round. [Recovery](references/recovery.md) covers resolving and aborting.

## 5. Force-push only after looking at what it would overwrite

After rewriting a published branch, run this as one command, with `topic` standing for the branch's name on both sides. Shell variables do not survive from one tool call to the next, and the push must not run when the check finds anything:

```bash
git fetch origin &&
  checked=$(git rev-parse origin/topic) &&
  rewritten=$(git rev-list $(git reflog show --format=%H topic) --not topic) &&
  lost=$(git log --format='%h %an %s' --cherry-pick --right-only "topic...$checked" --not $rewritten) &&
  if [ -n "$lost" ]; then printf 'Not pushed. This would delete:\n%s\n' "$lost"; false; else git push --force-with-lease="topic:$checked" origin topic; fi
```

- `lost` lists the commits a forced push would delete from the remote: their change is not in your branch, and your branch never contained them. `rewritten` is what lets your own earlier commits (squashed, amended, reordered or resolved differently) drop out of that list; the branch's reflog remembers them. If it prints commits, nothing was pushed and the command exits with status 1. Tell the user which commits and authors would be lost, even when they asked you to force, bring the commits in only with their consent (`git cherry-pick SHA`), then run the command again.
- A commit counts as yours once your branch has contained it, for example after a pull or a reset onto `origin/topic`. If you dropped such a commit later, the check does not list it, so drop other people's commits only on purpose.
- The lease is pinned to the tip the check read, so a commit that reaches the remote after the check makes the push fail instead of disappearing. A bare `--force-with-lease` is no substitute: it compares with whatever the remote-tracking ref holds at push time, and any fetch, yours or a background one, moves that ref.
- Name the remote branch rather than `@{upstream}`, which can point at another branch, such as `origin/main`.
- Never force-push the default branch, a release branch or a branch others work on without their explicit agreement, and never with a plain `--force`, `-f` or `+refspec`.

## 6. Undo according to where the commit is

| Situation | Command | Why this one |
| --- | --- | --- |
| Last commit not pushed | `git reset --soft HEAD~1` | The change stays staged. |
| Commit already pushed | `git revert SHA`, on a branch | History stays intact; for a merge commit use `git revert -m 1 SHA`. |
| Committed on `main` by mistake, not pushed | `git branch topic`, then `git reset --keep origin/main` | `--keep` refuses rather than drop uncommitted edits. |
| Commits lost after a reset or rebase | `git reflog`, then `git branch rescue SHA` | Touches nothing else; merge or cherry-pick from `rescue`. |
| A merge or rebase went wrong | `git merge --abort` or `git rebase --abort` | Returns to where it started. |

`git reset --hard`, `git clean -f`, `git checkout -- .` and `git restore` on unstaged files destroy uncommitted work that no reflog keeps. Ask first, and prefer the commands above. [Recovery](references/recovery.md) covers reverted merges, lost commits, bisect and secrets in depth.

## 7. Secrets

A secret in a pushed commit is exposed. Tell the user to revoke or rotate it first: removing it from Git does not make it safe again. Never write the value anywhere: not in a message, a commit message, a command line, a pull request, an issue, a file or a test. Refer to it by file and line, and mask it when you read the file. If it was never pushed, amend or rebase it out before any push. Rewriting published history comes only after rotation and with explicit approval, because every later commit gets a new hash and every affected branch needs a force-push; [recovery](references/recovery.md) has the procedure.

## 8. Tags and releases

Tag what the remote has, not a local branch that may be behind:

```bash
git fetch origin
git tag -n -l 'v*'
git tag -a v1.4.0 -m 'Release 1.4.0' origin/main
```

Match the names and messages of existing tags. Use annotated tags, because `git describe` ignores lightweight ones. Never move or delete a tag that has been pushed; release a new version instead. Push a tag by name, `git push origin v1.4.0`, and only when asked.

## 9. Pull requests and merging

- Keep a pull request to one purpose and small enough to review in one sitting. Its description says what changed and why, which checks ran and their results, the risk, and how to roll back. The repository's template wins.
- Merge with a method the repository allows (`gh repo view --json mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed`), and never with `gh pr merge --admin`, which skips required checks and merge queues.
- After a squash or rebase merge, Git does not see the branch as merged, so `git branch -d` refuses. Check the pull request (`gh pr view topic --json state,mergedAt`) and ask before deleting the branch.
- [Collaboration](references/collaboration.md) covers branching models, merge queues, stacked pull requests, releases, hotfixes, branch cleanup and parallel agents.

## 10. Report

End with what changed and where: the branch, each commit as short SHA and subject, and anything pushed or tagged. Name what you left out or did not do and why, such as files not committed, a push not made, or commits a force-push would have dropped.

Setting up a repository or a machine (recommended configuration, signing, server-side rules, hooks, untrusted repositories, Git 3.0): [repository setup](references/repo-setup.md).
