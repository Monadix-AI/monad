---
title: "Agent documentation"
description: "Repository-only guidance for coding agents working on Monad."
audience: "internal-agent"
---
This directory contains repository-only guidance for coding agents. Mintlify excludes it from the public documentation site.

`AGENTS.md` is generated from `.rulesync/rules/` and remains the source of truth for agent instructions. Do not copy those rules into this directory. Use these pages only for workflows that need more depth than the generated instruction file.

## Guides

- [Parallel agent development](parallel-agents.md): coordinate several coding agents without sharing working trees, ports, or ownership
