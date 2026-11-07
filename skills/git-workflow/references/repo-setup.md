# Repository and machine setup

## Contents

- Ask first
- Recommended configuration
- Commit signing
- Server-side rules
- Hooks
- Repositories you did not create
- Git 3.0 readiness

## Ask first

Global Git configuration, hooks, signing keys and server-side rules affect every repository or every collaborator. Change them only when the user asks, and show the commands. Repository-local configuration (`git config` without `--global`) affects only that clone.

## Recommended configuration

| Setting | Effect |
| --- | --- |
| `pull.ff=only` | `git pull` refuses to create a merge on a diverged branch. |
| `push.autoSetupRemote=true` | The first `git push` of a new branch publishes it and sets its upstream. |
| `push.useForceIfIncludes=true` | Every `--force-with-lease` without a pinned value also applies `--force-if-includes`, which refuses unless the remote tip is in the branch's reflog; a safety net for forced pushes made without the check in the skill. |
| `rebase.updateRefs=true` | A rebase moves every branch of a stack. |
| `merge.conflictStyle=zdiff3` | Conflict markers also show the common base. |
| `rerere.enabled=true` | Git reuses recorded conflict resolutions. |
| `fetch.prune=true` | A fetch drops remote-tracking refs for deleted remote branches. |
| `transfer.fsckObjects=true` | Fetches and pushes received abort on malformed objects. |
| `init.defaultBranch=main` | New repositories start on `main`, as Git 3.0 will by default. |

`rebase.autoSquash=true` affects only interactive rebases; pass `--autosquash` to a plain rebase.

## Commit signing

SSH signing uses a key most developers already have:

```bash
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git config commit.gpgsign true
git config tag.gpgsign true
git config gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

- Without `gpg.ssh.allowedSignersFile`, Git cannot verify SSH signatures: `git log --format=%G?` shows `N` even for a good signature. Each line of the file is an email address, `namespaces="git"`, and a public key.
- On GitHub, add the public key as a signing key. A signature verified there stays verified even after the key is rotated or revoked.
- When signing is configured and fails, stop and report. Never turn signing off to get a commit through.

## Server-side rules

Hooks run on the developer's machine and can be skipped there; only the host can enforce a rule. On GitHub, a ruleset on the default branch typically restricts deletions, blocks force pushes, requires a pull request and passing status checks, and can also require signed commits, linear history and a merge queue. Secret scanning push protection blocks known secret formats at push time. For supply-chain levels, SLSA's source track requires branches that only move forward (no force pushes) at level 2 and review by two trusted people at level 4.

## Hooks

- Run the repository's own checks before committing, for example `pre-commit run --files FILE` where the repository uses the pre-commit framework.
- On Git 2.54 and later, hooks can be defined in configuration: `hook.NAME.event` names the hook event, `hook.NAME.command` the command, and `hook.NAME.enabled=false` turns one off. `git hook list pre-commit` shows what will run. Such a hook in `~/.gitconfig` runs in every repository.
- Dependabot can keep the `rev` pins in `.pre-commit-config.yaml` current through its `pre-commit` ecosystem.

## Repositories you did not create

- A clone copies neither hooks nor `.git/config`. A copied or unpacked repository, such as an archive or a shared folder, brings both, and `.git/config` can name programs that Git runs during ordinary commands: `core.fsmonitor`, for one, runs on `git status`. Read `.git/config` and `.git/hooks/` before running Git in a repository you did not clone yourself.
- `safe.bareRepository=explicit`, Git 3.0's planned default, stops Git from using a bare repository found inside a project's files, a known way to plant hooks.
- Keep Git patched. Git's security advisories are published in the git/git repository on GitHub.

## Git 3.0 readiness

Git 3.0 will default new repositories to SHA-256 object names, reftable ref storage and the branch name `main`. To keep scripts working:

- Ask Git for the formats with `git rev-parse --show-object-format` and `git rev-parse --show-ref-format`. Do not assume 40-character object names; SHA-256 names have 64.
- Read and write refs with Git commands such as `git for-each-ref` and `git update-ref`. A reftable repository has no files under `.git/refs/heads/`.
- Pass `-b main` to `git init` rather than relying on the default.
