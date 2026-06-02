---
name: commit
description: Stage and commit the current changes with a conventional-commit message.
disable-model-invocation: true
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)
---

Commit the current changes. If `$ARGUMENTS` is provided, use it as the commit subject;
otherwise write a concise conventional-commit subject yourself from the diff.

1. Review `git status` and the diff.
2. Stage the relevant files.
3. Commit with a clear message: a one-line subject, then a short body if the change warrants it.
4. Report the resulting commit.

This skill is user-only (`disable-model-invocation`) — it runs when you type `/commit`, never
on the model's own initiative.
