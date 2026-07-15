# User-First README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the repository entry page with a polished user-first English README and a structurally aligned Chinese README that lead from product value to a working install and first session.

**Architecture:** `README.md` is the English source of product facts and `README.zh-CN.md` mirrors its section order with idiomatic Chinese prose. Both use repository-owned light/dark wordmarks, current installed CLI commands, and links into the existing documentation map rather than duplicating reference material.

**Tech Stack:** GitHub-flavored Markdown, HTML `<picture>`, repository SVG assets, Bun CLI help, shell-based link and drift checks.

## Global Constraints

- The first screenful must identify Monad and expose a working install path.
- The installed `monad` binary is the user-facing CLI entry point.
- The English and Chinese README files use the same section order and command blocks.
- State is local by default, but configured model-provider requests may leave the machine.
- The daemon binds loopback only by default.
- Do not claim a fixed provider count, exact memory footprint, or unsupported release target.
- Use only repository-owned visual assets.
- Do not present `apps/cli/src/main.ts` as normal CLI usage.

---

### Task 1: Theme-safe wordmark assets

**Files:**
- Create: `docs/assets/monad-logo-dark.svg`
- Consume: `apps/web/public/monad-logo-vector-solid.svg`

**Interfaces:**
- Consumes: the existing wordmark geometry and `viewBox="0 0 1410 446"`.
- Produces: a white-fill SVG with identical geometry for README dark-mode rendering.

- [x] **Step 1: Create the dark-theme derivative**

Copy the existing wordmark SVG to `docs/assets/monad-logo-dark.svg`. Preserve the title, dimensions, view box, transform, and path exactly; change only `fill="#000000"` to `fill="#ffffff"` and update the source comment to identify it as the GitHub dark-theme derivative.

- [x] **Step 2: Verify geometry identity**

Compare the `<path d="…"/>` payload from the source and derivative. Expected: identical path data and transforms; only the fill color and explanatory comment differ.

---

### Task 2: Rewrite the English product entry point

**Files:**
- Replace: `README.md`
- Reference: `docs/product.md`
- Reference: `docs/usage/cli.md`
- Reference: `docs/internals/runtime.md`
- Reference: `scripts/install.sh`
- Reference: `scripts/install.ps1`

**Interfaces:**
- Consumes: current product positioning, release install paths, CLI command registry, and security boundaries.
- Produces: the canonical English README structure mirrored by Task 3.

- [x] **Step 1: Build the header and first screenful**

Use this heading order and header contract:

```markdown
<picture>…light/dark wordmark sources…</picture>

# Monad

> Your local AI agent runtime — one daemon, every interface, your data.

[CI badge] [MIT badge] [macOS | Linux | Windows badge]

[Quick start](#quick-start) · [Features](#features) · [Documentation](#documentation) · [简体中文](README.zh-CN.md)
```

Follow it with no more than two short paragraphs defining the local daemon, shared client surfaces, local-state default, provider-network boundary, and loopback-only binding default.

- [x] **Step 2: Add the quick-start path**

Create `## Quick start` with:

```bash
curl -fsSL https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.sh | bash
monad
```

Add the Windows equivalent:

```powershell
irm https://raw.githubusercontent.com/Monadix-AI/monad/main/scripts/install.ps1 | iex
monad
```

Explain that bare `monad` starts the daemon and opens the Web UI. Link manual installation to the later installation section.

- [x] **Step 3: Explain differentiation and features**

Add `## Why Monad` with four compact lead-ins: Local-first, One daemon/every interface, Progressive autonomy, Extensible and contained.

Add `## Features` as a two-column table with these rows and destinations:

- Sessions → `docs/usage/sessions.md`
- Models → `docs/usage/model-providers.md`
- Skills → `docs/usage/skills.md`
- Atom packs → `docs/internals/atoms.md`
- Channels → `docs/usage/channels.md`
- Sandboxing → `docs/usage/sandbox-backends.md`
- Editor agents → `docs/internals/acp.md`
- Peer federation → `docs/internals/peer-federation.md`

Each outcome cell is one sentence and avoids volatile counts.

- [x] **Step 4: Add the operating model**

Create `## How it works` with a compact text diagram showing Web UI, CLI, TUI, editors, and IM channels feeding one local daemon, then sessions/approvals/tools/models/local storage beneath it. Follow with the provider-network boundary and links to daemon architecture and runtime security.

- [x] **Step 5: Reorganize installation and usage**

Create `## Installation` with `### Recommended installer`, `### Manual installation`, and `### System requirements`. Preserve checksum verification for manual archives. State supported release families as macOS/Linux/Windows on arm64 or x64 and describe musl builds without exact resource estimates.

Create `## Using Monad` with this verified journey:

```bash
monad
monad status
monad session new "my session"
monad session send <sessionId> "hello"
monad session watch <sessionId>
monad model list
monad config set network.transport uds
monad doctor
```

Link the complete command reference to `docs/usage/cli.md`.

- [x] **Step 6: Add concise developer and governance navigation**

Create `## Development` with:

```bash
bun install
bun run dev
bun run dev:doctor
bun run quality:check
```

State that setup is idempotent and dev state stays under `.dev/`. Link `CONTRIBUTING.md` and `docs/engineering/`.

Finish with `## Documentation`, `## Community and security`, and `## License`. Group links to the documentation map, concepts, product, changelog, contributing, security policy, and code of conduct.

---

### Task 3: Add the Chinese product entry point

**Files:**
- Create: `README.zh-CN.md`
- Consume: `README.md`

**Interfaces:**
- Consumes: the completed English heading order, command blocks, facts, and link targets.
- Produces: an idiomatic Simplified Chinese entry point with no additional product claims.

- [x] **Step 1: Mirror the header and navigation**

Use the same `<picture>` block and badges. Use this value proposition:

```markdown
> 你的本地 AI Agent 运行时——一个守护进程，连接每个界面，数据由你掌控。
```

Link back with `[English](README.md)` and translate the other navigation labels.

- [x] **Step 2: Translate the user journey naturally**

Mirror these English sections in the same order:

```text
Quick start              快速开始
Why Monad                为什么选择 Monad
Features                 核心能力
How it works             工作方式
Installation             安装
Using Monad              使用 Monad
Development              参与开发
Documentation            文档导航
Community and security   社区与安全
License                  许可证
```

Keep every shell and PowerShell command byte-for-byte aligned with `README.md`. Translate surrounding prose naturally rather than sentence-by-sentence.

- [x] **Step 3: Verify factual parity**

Compare all URLs, relative link targets, platform names, transport names, and code blocks against the English source. Remove any Chinese-only promise or numeric claim.

---

### Task 4: Verify rendering contracts and repository truth

**Files:**
- Verify: `README.md`
- Verify: `README.zh-CN.md`
- Verify: `docs/assets/monad-logo-dark.svg`

**Interfaces:**
- Consumes: both completed README files and current repository command/docs surfaces.
- Produces: evidence that the documentation is navigable, aligned, and current.

- [x] **Step 1: Check stale CLI forms and current help**

Run:

```bash
if rg -n 'bun run apps/cli/src/main\.ts|monad health|monad create|monad config transport' README.md README.zh-CN.md; then exit 1; fi
bun run apps/cli/src/bin.ts --help
bun run apps/cli/src/bin.ts help session
```

Expected: no stale forms; help includes `status`, `session`, `model`, `config`, and `doctor`.

- [x] **Step 2: Check heading and command parity**

Extract headings and fenced command contents from both files. Confirm the mapped section order is identical and all executable command lines match byte-for-byte.

- [x] **Step 3: Check every local link and image target**

Extract Markdown and HTML relative targets from both README files, strip anchors, and verify each target exists from the repository root. Explicitly verify both wordmark files referenced by `<picture>`.

- [x] **Step 4: Run repository formatting checks**

Run:

```bash
bunx biome check README.md README.zh-CN.md docs/assets/monad-logo-dark.svg
git diff --check
```

Expected: exit zero with no formatting errors or whitespace violations.

- [x] **Step 5: Inspect the final diff**

Read the two README files top to bottom and compare them against every acceptance criterion in `docs/superpowers/specs/2026-07-15-readme-redesign-design.md`. Confirm no unrelated source or dependency file is included.
