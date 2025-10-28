# Git Pull Configuration

When synchronizing this repository with `git pull`, Git may report:

```
fatal: Need to specify how to reconcile divergent branches.
```

Set a preferred pull strategy once per clone to avoid the prompt. For example, to merge remote changes with your local commits, run:

```
git config pull.rebase false
```

To rebase instead of merging:

```
git config pull.rebase true
```

Or to allow only fast-forward pulls:

```
git config pull.ff only
```

Apply `--global` to the commands if you want the setting for all repositories.
