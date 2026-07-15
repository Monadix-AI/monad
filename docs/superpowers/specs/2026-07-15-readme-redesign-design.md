# README Redesign Design

## Goal

Turn the repository README into a polished, user-first product entry point that helps a new user understand Monad, install it, and start a first session without losing the technical credibility expected of an open-source agent runtime.

The root `README.md` remains English. A new `README.zh-CN.md` provides a natural Chinese counterpart with the same structure, commands, facts, and link targets.

## Audience and priorities

The primary audience is an end user encountering Monad for the first time. Contributor and architecture material remains available, but it appears after the product explanation and first-run path.

The README must answer, in order:

1. What is Monad?
2. Why would I use it?
3. How do I install and start it?
4. What can it do?
5. How does it keep control and state local?
6. Where do I go for deeper usage, architecture, or contribution guidance?

## Visual direction

Use the existing `apps/web/public/monad-logo-vector-solid.svg` wordmark at the top of both README files. Because that asset has a fixed black fill, add a repository-owned white-fill derivative under `docs/assets/` and render the pair with a `<picture>` element so GitHub light and dark themes both retain contrast. The derivative must preserve the original geometry and change only the fill color. The header contains the product name, one concise value proposition, a restrained badge row, and direct navigation links for quick start, features, documentation, and language switching.

The presentation relies on typography, whitespace, short paragraphs, Markdown tables, and one compact text architecture diagram. It does not introduce screenshots, decorative emoji, HTML card grids, gradients, or a large badge wall. The result should render cleanly on GitHub, in terminals, and in plain Markdown viewers.

The English value proposition is:

> Your local AI agent runtime — one daemon, every interface, your data.

The Chinese version communicates the same promise naturally rather than translating word for word.

## Information architecture

### Header

- Existing Monad logo
- Product name and value proposition
- CI and MIT license badges, plus a restrained platform-support badge
- Navigation links: Quick start, Features, Documentation, Chinese/English
- A short paragraph defining Monad and stating the local-state and loopback defaults

### Quick start

Make the installation script the primary macOS/Linux path, followed by running `monad`. Show the equivalent PowerShell installer for Windows. Explain that the bare `monad` command starts the daemon and opens the web UI.

Do not make manual archive download and checksum verification the first-run path. Preserve those instructions in a clearly labeled manual-install subsection.

### Why Monad

Use four compact ideas instead of a long feature dump:

- Local-first state and loopback-only defaults
- One daemon shared by Web, CLI, TUI, editors, and messaging channels
- Progressive autonomy with visible actions and approvals
- Extensibility through skills, atom packs, MCP, and delegated runtimes within explicit containment boundaries

### Features

Use a compact table for Sessions, Models, Skills, Atom packs, Channels, Sandbox, ACP, and Peer federation. Each row contains one plain-language outcome and a link to the relevant usage or internals document.

Avoid volatile marketing numbers such as a fixed provider count. Prefer durable capability descriptions backed by the current repository.

### How it works

Include a small Markdown text diagram that shows Web UI, CLI, TUI, editors, and IM channels connecting to one local daemon. The daemon owns sessions, tools, models, approvals, and local storage. Model requests leave the machine only for the provider configured by the user.

The diagram is explanatory, not a complete component architecture. Deeper implementation detail links to `docs/internals/daemon-architecture.md` and `docs/internals/runtime.md`.

### Installation and requirements

Organize installation into:

1. Recommended scripted install for macOS/Linux
2. Recommended PowerShell install for Windows
3. Manual release archive download and checksum verification
4. Concise system requirements and supported release targets

Only claim platform and architecture combinations produced by the release build. Avoid precise idle-memory or disk-usage claims unless they are enforced by a maintained benchmark.

### Using Monad

Show a short verified command journey:

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

The installed `monad` binary is the user-facing entry point. Source paths such as `apps/cli/src/main.ts` must not be presented as normal CLI usage.

### Development

Keep contributor setup brief:

```bash
bun install
bun run dev
bun run dev:doctor
bun run quality:check
```

Explain that setup is idempotent and development state is isolated under `.dev/`. Link to `CONTRIBUTING.md` and the engineering documentation rather than duplicating the full contributor workflow.

### Closing navigation

End with grouped links for user documentation, architecture, contributing, security reporting, community standards, changelog, and license. These links replace the current governance interruption near the top of the page.

## Chinese README

`README.zh-CN.md` mirrors the English section order and command blocks so the two files remain maintainable. Its prose is idiomatic Chinese and may adjust sentence rhythm, but it must not add product promises or technical claims absent from the English source.

Both files link to one another near the top. Documentation links continue to target the existing English reference docs until dedicated Chinese reference documentation exists.

## Truth and safety constraints

- CLI examples must match the current command registry and `docs/usage/cli.md`.
- Monad stores its own state locally, but configured model-provider requests may leave the machine.
- The daemon binds loopback only by default; remote exposure requires the documented security model.
- Platform support must match current release targets.
- Do not claim a fixed provider count, exact memory footprint, or other values likely to drift.
- Do not describe direct source execution as the normal installed CLI workflow.
- Use only repository-owned visual assets so the README has no third-party image dependency.

## Verification

Before completion:

- Verify every relative link in both README files resolves to an existing repository path.
- Compare every CLI example with current help output or command definitions.
- Confirm the English and Chinese command blocks and section order remain aligned.
- Search both files for stale `bun run apps/cli/src/main.ts` user examples.
- Run Markdown-compatible formatting checks where available and `git diff --check`.
- Inspect the rendered Markdown structure for heading order, table readability, logo sizing, and code-block clarity.

## Acceptance criteria

- A first-time user can identify Monad and reach a working install command within the first screenful.
- The default path from install to opening the Web UI requires no architecture knowledge.
- Product capabilities are scannable without reading long bullet paragraphs.
- Security and local-first claims accurately describe provider-network boundaries.
- English and Chinese entry points are equally complete and easy to switch between.
- Contributor material remains discoverable without dominating the user journey.
- All commands, links, platform claims, and visual assets are verified against the repository.
