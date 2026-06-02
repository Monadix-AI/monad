---
title: "Understand Monad Engineering"
description: "Understand the repository architecture, engineering philosophy, and technology choices behind Monad."
sidebarTitle: "Engineering Overview"
---
Monad's public engineering documentation explains why the repository has its current boundaries and how the major layers fit together. Use the runtime internals for subsystem behavior and the repository contribution guide for change-specific rules.

## Start with the repository model

Read these pages in order:

| Document | What it explains |
|---|---|
| [Engineering philosophy](/engineering/philosophy) | Why verification, explicit contracts, and narrow ownership shape the repository |
| [Repository architecture](/engineering/architecture) | Package boundaries, dependency direction, daemon ownership, and extension points |
| [Technology stack](/engineering/tech-stack) | The runtimes, libraries, build tools, and quality systems used by each layer |
| [Runtime architecture](/internals/index) | How requests, state, transports, Agent runtimes, and Monad Mesh work at runtime |

## Contribute to the repository

Repository rules and development practices do not belong on the product documentation site. Start with [CONTRIBUTING.md](https://github.com/Monadix-AI/monad/blob/main/CONTRIBUTING.md), then use the [repository-only development documentation](https://github.com/Monadix-AI/monad/tree/main/docs/internal/development) for code conventions, security, performance, testing, worktrees, and release operations.

Coding-agent instructions have a separate source of truth. Edit `.rulesync/rules/`, run `bun run agents:sync`, and use the [agent documentation](https://github.com/Monadix-AI/monad/tree/main/docs/internal/agents) only for deeper coordination guidance.
