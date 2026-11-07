# Recovery

## Contents

- Conflicts
- Undoing changes
- Reverting a merge
- Finding lost commits
- Bisect
- Secrets

## Conflicts

1. `git status` names the conflicted files and the operation in progress.
2. Resolve each file. With `merge.conflictStyle=zdiff3`, the markers also show the common base between `|||||||` and `=======`, which tells you what each side changed.
3. Stage the resolution. On Git 2.56 and later, `git add --resolved` stages only the paths that were in conflict, leaves unrelated edits unstaged, and refuses while any of them still holds conflict markers. On older Git, stage the paths by name and run `git diff --cached --check`, which reports leftover markers.
4. Continue. `git rebase --continue` and `git merge --continue` open an editor for the commit message, which an agent cannot use; `GIT_EDITOR=true` accepts the prepared message, and it must be the environment variable, because an exported `GIT_EDITOR` overrides `-c core.editor`. `git cherry-pick --continue` and `git commit --no-edit` (which also finishes a merge) open no editor:

   ```bash
   GIT_EDITOR=true git rebase --continue
   git cherry-pick --continue
   git commit --no-edit
   ```

5. To give up, run `git rebase --abort`, `git merge --abort` or `git cherry-pick --abort`. Each returns to where the operation started, and edits to files the operation did not touch stay.

Which side is which:

| Operation | `--ours` | `--theirs` |
| --- | --- | --- |
| `git merge other` | your branch | `other` |
| `git rebase base` | `base`, plus your commits already replayed | your commit being replayed |

`git checkout --ours FILE` or `git checkout --theirs FILE` takes one side whole. With `rerere.enabled=true`, Git records how you resolved a conflict and applies the same resolution when that conflict comes back, as it does when a long branch is rebased again.

## Undoing changes

| You want to | Command | What survives |
| --- | --- | --- |
| Unstage a file | `git restore --staged FILE` | The edit. |
| Undo the last unpushed commit | `git reset --soft HEAD~1` | Everything, staged. |
| Move unpushed commits off the wrong branch | `git branch topic`, then `git reset --keep origin/main` | Uncommitted edits; it refuses if they would be lost. |
| Undo a pushed commit | `git revert SHA` | All history. |
| Change an earlier unpushed commit | `git commit --fixup=SHA`, then `git rebase --autosquash BASE` | Everything else. |
| Discard edits to a file | `git restore FILE` | Nothing: ask first. |
| Remove untracked files | `git clean -n` lists them; ask before deleting | Nothing once deleted. |

## Reverting a merge

`git revert -m 1 MERGE` undoes a merge commit; `-m 1` keeps the side that was merged into. Git still counts the merged commits as part of history, so merging the same branch again brings none of them back. To restore the work, revert the revert (`git revert REVERT`), then merge any newer commits from the branch.

## Finding lost commits

- `git reflog` lists where `HEAD` pointed, newest first; `git reflog show topic` does the same for a branch. `HEAD@{1}` is the previous position.
- `git branch rescue SHA` keeps a commit without touching the working tree. Bring it back with `git merge --ff-only rescue` when the branch has not moved, or `git cherry-pick SHA` when it has.
- Reflog entries for commits that are no longer on any branch expire after 30 days by default (`gc.reflogExpireUnreachable`), other entries after 90 days (`gc.reflogExpire`). After that, `git fsck --lost-found` still lists dangling commits until garbage collection prunes them.
- Content that was staged and then lost shows up in `git fsck --lost-found` as a dangling blob. Edits that were never staged or committed were never in Git, and nothing recovers them.

## Bisect

```bash
git bisect start BAD GOOD
git bisect run ./check.sh
git bisect reset
```

The check's exit code decides each step: 0 means good, 1 to 127 except 125 means bad, 125 means this commit cannot be tested and is skipped, and anything else stops the bisect. Return 125 for a commit that does not build, so a build failure is not mistaken for the bug. On Git 2.56 and later, `git bisect run --reset-when-found ./check.sh` resets on its own when it finds the commit.

## Secrets

1. Revoke or rotate the secret first. That is the fix; everything else limits further exposure.
2. Do not write the value anywhere: not in a message, a commit message, a command line, a pull request, an issue, a file or a test. Refer to it by file and line, and mask it when you read the file.
3. If it was never pushed, remove it from the commits (amend, or `git commit --fixup` and `git rebase --autosquash`) before any push.
4. If it was pushed, a history rewrite is a separate operation that needs the user's approval: the separately installed `git filter-repo --sensitive-data-removal --invert-paths --path FILE`, then a force-push of every affected branch and tag. Every later commit gets a new hash, signatures on rewritten commits are lost, open pull requests break, and every clone must be replaced. Copies outside the repository, such as cached views and pull request refs on the host, need the host's support to remove.
5. GitHub's push protection blocks many known secret formats at push time. For an individual account it is on by default for pushes to public repositories; repository-level push protection is an administrator setting.
