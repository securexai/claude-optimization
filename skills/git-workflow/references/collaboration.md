# Collaboration

## Contents

- Branching model
- Pull requests
- Merge methods and signatures
- Merge queues
- Stacked branches and pull requests
- Releases and hotfixes
- Cleaning up branches
- Parallel agents and worktrees

## Branching model

Default to trunk-based development: short-lived branches merged into `main` at least once a day, three or fewer active branches, and no code freezes. Branches last hours or days, not weeks. Keep a long-lived release or develop branch only when the repository already has one, or when the software ships explicitly versioned releases with several versions supported at once; that is the case git-flow was designed for, and its author recommends a simpler flow for continuously delivered software.

## Pull requests

- Work in small batches. Each pull request should be reviewable in one sitting. Large generated changes are the usual way this fails with AI tools, because they are harder to review, test and integrate safely.
- Open a draft while the work is not ready for review.
- The description states what changed and why, how it was tested (commands and results), the risk, and how to roll it back, and links related issues or pull requests.
- Answer review with new commits so reviewers see what changed. Squash or fix up before merging only if the repository wants a tidy history.
- Opening, commenting on, merging or closing a pull request is visible to others. Do it only when asked.

## Merge methods and signatures

- A merge commit keeps the branch's commits and records the merge. A squash merge lands one new commit per pull request. A rebase merge replays the branch's commits onto the base.
- A "require linear history" rule allows only squash and rebase merges.
- On GitHub, a rebase merge adds the head branch's commits without signature verification, because GitHub cannot sign them with the author's key. Under a "require signed commits" rule, unsigned commits on the head branch can block a squash merge even though GitHub signs the squash commit.

## Merge queues

- When the target branch requires a merge queue, `gh pr merge` needs no merge method. It enables auto-merge while required checks are pending and adds the pull request to the queue once they pass. `--admin` bypasses the queue; do not use it.
- CI must also run on the `merge_group` event, or queued pull requests never get their required checks.

## Stacked branches and pull requests

- `git rebase --update-refs BASE` run from the top branch rebases the whole stack and moves every branch in it. `rebase.updateRefs=true` makes that the default.
- Open each pull request against the branch below it. After the bottom one merges, the next one must target `main`; GitHub's stacked pull requests retarget automatically, and so does the `gh stack` CLI extension. Use those only if the repository already does.

## Releases and hotfixes

- Tag the commit on the remote (`origin/main` after a fetch) with an annotated tag. In a tag such as `v1.2.3`, the `v` is a convention; the Semantic Versioning version is `1.2.3`.
- Never move or reuse a published tag; release a new version.
- Fix a bug on `main` first, then bring the fix to a release branch with `git cherry-pick -x SHA`; `-x` records the source commit in the message.
- Generate changelogs only with the tool the repository already uses.

## Cleaning up branches

- `git fetch --prune` (or `fetch.prune=true`) removes remote-tracking refs for branches deleted on the remote.
- `git branch --merged main` and `git branch -d` recognise a branch only when its commits are in `main`. A squash or rebase merge creates new commits, so check the pull request state instead.
- On Git 2.56 and later, `git branch --delete-merged 'origin/*' --dry-run` lists local branches whose work has already landed on their upstream. It skips a branch that tracks its own pushed copy, because that branch looks merged right after every push. Show the list and ask before deleting branches the task did not create.

## Parallel agents and worktrees

- Give each agent or concurrent task its own worktree. A branch can be checked out in only one worktree at a time.
- In Claude Code, `claude --worktree NAME` (or the EnterWorktree tool) creates `.claude/worktrees/NAME` on a new branch `worktree-NAME`. A `.worktreeinclude` file at the repository root lists gitignored files, such as `.env`, to copy into each new worktree. A custom subagent can run in its own worktree with `isolation: worktree`.
- Remove a worktree with `git worktree remove PATH`. Git refuses while it holds changes or untracked files, and refuses a locked worktree until `git worktree unlock PATH`.
