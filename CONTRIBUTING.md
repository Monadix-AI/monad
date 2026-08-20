# Contributing to monad

Thanks for your interest in contributing! This guide covers the local setup,
the checks your change has to pass, and how we handle commits and pull
requests.

## Prerequisites

monad is a [Bun](https://bun.sh) project. The active Bun version is pinned in
`"packageManager"` in `package.json` and managed by [mise](https://mise.jdx.dev).

- Git
- mise
- An [OpenRouter API key](https://openrouter.ai/keys) to run against a live model (`OPENROUTER_API_KEY`)

> Replace `node`/`npm`/`npx` with `bun`/`bun run`/`bunx` throughout.

---

### Install and activate mise

Install mise once. On macOS:

```sh
brew install mise
```

For Linux and Windows, follow the
[mise installation guide](https://mise.jdx.dev/installing-mise.html).

Activate mise in your interactive shell. Copy and paste the complete block for your
shell once; it saves the activation command in your shell profile and reloads the
shell immediately.

#### zsh

```sh
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc
exec zsh
```

#### bash

```sh
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
exec bash
```

macOS users who run bash as a login shell should use `~/.bash_profile` instead:

```sh
echo 'eval "$(mise activate bash)"' >> ~/.bash_profile
exec bash -l
```

#### fish

```fish
mkdir -p ~/.config/fish/conf.d
echo 'mise activate fish | source' >> ~/.config/fish/conf.d/mise.fish
exec fish
```

#### PowerShell

```powershell
New-Item -ItemType File -Path $PROFILE -Force | Out-Null
Add-Content -Path $PROFILE -Value 'mise activate pwsh | Out-String | Invoke-Expression'
. $PROFILE
```

Trust the checked-in configuration once per clone, then install the pinned Bun:

```sh
cd monad
mise trust
mise install
bun --version
```

From then on, entering a Monad checkout activates the Bun version from `package.json`,
loads that worktree's `.env.local`, and adds its `.dev/bin` to `PATH`. Leaving the
checkout restores the previous environment. The entry status prints the active Bun
version so the switch is visible.

If `mise install` succeeds but `bun` is still not found, verify the installed tool
without relying on shell activation:

```sh
mise exec -- bun --version
```

If that command prints the pinned Bun version, the installation is healthy and the
shell activation block above has not been loaded by the current shell.

---

### Upgrading the Bun version

```json
"packageManager": "bun@1.3.15"
```

```json
"image": "oven/bun:1.3.15"
```

Every developer's environment picks up the new version automatically on next `cd`.

## Getting started

```bash
git clone https://github.com/Monadix-AI/monad.git
cd monad
mise trust
mise install
bun install              # installs deps and sets up git hooks (lefthook)
bun run dev              # daemon (@monad/monad) + web UI
```

`bun install` is the one-step initializer. It creates `.env.local`, assigns stable
worktree ports, installs local shims and hooks, and refreshes generated inputs.
Optional observability services start explicitly with `mise run dev:services`. Run
`mise run dev:doctor` if any part of the environment is unhealthy.

The repo is a monorepo managed with Bun workspaces, Turbo, and mise tasks:

- `apps/` — the daemon (`monad`), `cli`, `tui`, and `web` UI
- `packages/` — shared libraries (`@monad/*`: protocol, store, tools, …)

Dev data is isolated under `.dev/` (gitignored) — it never touches your real
`~/.monad`. See the [README](README.md) for the runtime/transport model.

## Required checks

Each commit checks only staged changes. Biome applies safe and unsafe fixes, staged
TypeScript workspaces are checked, and staged package manifests are formatted and
linted with Syncpack. Unstaged and untracked changes are hidden for the duration of
the hook, including unstaged hunks in partially staged files.

```bash
mise run quality:check     # complete local and CI read-only quality checks
bun run test               # cross-package Bun tests
```

The complete quality gate covers Biome, syncpack, knip, dependency direction,
agent-rule and i18n generation, database history/drift, and workspace typechecking.
CI runs it, verifies it left the tracked checkout unchanged, and runs the test suite
on Linux, macOS, and Windows. Don't bypass the hooks.

The quality dependency graph and scoped commands live in `mise.toml`; use
`mise tasks deps quality:check` to inspect the graph or `mise run quality:<name>` to
run one check directly.

Fork PRs run the same matrix without repo secrets: the Turbo remote cache is
skipped (builds are just slower) and live-model suites self-skip without
`OPENROUTER_API_KEY`. Neither affects whether your checks pass.

When you touch `apps/monad`, exercise the feature over **every transport**
(TCP loopback and the Unix socket) — the daemon's behaviour must match on both.

## Agent instruction files

Agent-facing files are local generated output — don't hand-edit them. The committed
single source is [`.rulesync/rules/`](.rulesync/rules/); Rulesync compiles it into
`AGENTS.md`, tool-specific agent files, and MCP configuration for the tools installed
on the developer's machine. Generated targets are gitignored.

Edit the source, then regenerate:

```bash
bun run agents:sync     # regenerate local agent targets from .rulesync/
mise run quality:agents # verify the local targets match the source
```

The quality gate regenerates these ignored local targets before checking them. To add
or remove a tool-specific target, edit `rulesync.jsonc`, not generated output.

**Personal rules** (just for you, never committed) go in `.rulesync.local/rules.md`;
`mise run agents:local` fans them into gitignored local slots (`CLAUDE.local.md`,
`.cursor/rules/*.local.mdc`) that layer on top of the shared files. See
[`.rulesync.local/README.md`](.rulesync.local/README.md).

## Documentation site

Everything under [`docs/`](docs/) is published directly to Mintlify. The directory is
the Mintlify project root: [`docs/docs.json`](docs/docs.json) owns navigation and site
configuration, and every Markdown page carries its own `title` frontmatter. There is no
generated documentation tree or publication branch.

Every Markdown file must appear exactly once in `docs.json`. Use root-relative,
extensionless links for another documentation page, such as `/usage/sessions`. Link to
repository files outside `docs/` with a full GitHub URL because Mintlify cannot resolve
paths outside its configured project root.

English is the default locale and stays at the documentation root. Translated pages live
under their locale directory, such as `docs/zh-Hans/`, and are mapped through
`navigation.languages`. A page path may belong to only one language. Add only translated
pages to a locale's navigation so partial translations do not create dead routes.

```bash
mise run docs:dev        # preview docs/ directly at http://localhost:3000
mise run quality:docs    # validate navigation, frontmatter, compilation, and links
```

`quality:docs` is part of `quality:check`. It fails when a Markdown file is omitted from
navigation, a navigation entry has no source file, a page lacks title frontmatter, the
Mintlify build emits a warning or error, or a link is broken. Mintlify deploys `main`
through its monorepo integration with the documentation path set to `/docs`.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org), enforced by
commitlint on the `commit-msg` hook. Format:

```
<type>(<optional scope>): <description>

# examples
feat(cli): add `config transport` subcommand
fix(store): close SQLite WAL handle on shutdown
docs: clarify remote-access token handling
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `build`,
`ci`. If you'd rather be guided through it, run `bunx cz` (commitizen).

## Branching & releases

We're **trunk-based**: development centres on `main`, and every release line is
cut from it. Day-to-day work targets `main`; the long-lived `beta` branch is a
*release channel*, not a parallel development line.

**Where you write code.** Pick the lightest path that fits the change:

- **Small, low-risk change** → commit straight to `main`. Keep each commit
  self-contained: Conventional-formatted (the `commit-msg` hook enforces this)
  and not knowingly breaking the build, since it ships in the next release.
- **Larger or risky change** → short-lived branch off `main` → PR, so the
  cross-OS CI matrix vets it *before* it's eligible for release. Also use a
  branch when several commits should land (or roll back) as one unit.

So *every commit that lands on `main` is a candidate for the next release.*

**The three release channels:**

| Channel | Branch | Cut by | Version |
| --- | --- | --- | --- |
| stable | `main` | [release-please](https://github.com/googleapis/release-please) PR — human-reviewed | `v0.2.0` |
| beta | `beta` | release-please PR (`prerelease`) — human-reviewed | `v0.2.0-beta.1` |
| nightly | `main` | scheduled CI, no human gate; builds `main`'s tip directly | `v0.2.0-nightly.<date>+<sha>` |

For **stable** and **beta**, release-please reads the Conventional Commit
history, opens a release PR with the version bump and generated `CHANGELOG.md`,
and tags once that PR is merged — that PR is the human gate. CI rewrites the PR
body with the exact `git-cliff` release notes and runs the complete quality matrix.
Every added commit cancels the superseded run, regenerates that body, and reruns
the gate. After merge, the release workflow only verifies the prepared draft,
builds, attests, and publishes its assets; it does not repeat the quality gate.

**nightly** is fully automatic: a daily job runs unit and integration
tests, builds `main`'s tip (skipping if there are no new commits), and publishes a
rolling prerelease with generated notes. Live-provider E2E runs on its own schedule
and cannot delay nightly publishing.

These channel branches are **not** version-maintenance branches. We do not keep
long-lived `release/*` branches for patching shipped versions; add one only if we
ever must patch an already-released version while `main` carries changes those
users can't take yet.

## Pull requests

1. Branch off `main` (see [Branching & releases](#branching--releases) for when
   a PR is worth it vs. committing straight to `main`).
2. Keep PRs focused; one logical change per PR is easier to review.
3. Make sure `typecheck`, `test`, and `lint` are green locally.
4. Fill in the PR template — what changed, why, and how you tested it.
5. A maintainer review is required before merge.

## Your first contribution

If you want to help but don't have a specific change in mind, these are good places to
start, roughly in order of ramp-up cost:

- **Use it and report what confused you.** A precise bug report or a "the docs said X but
  it did Y" issue is genuinely valuable, and needs no setup beyond installing.
- **Documentation.** Everything under [`docs/`](docs/) is normal Markdown. Fixing a stale
  path, an outdated flag, or a missing troubleshooting entry is a real contribution and
  the fastest way to learn the codebase. Note that `AGENTS.md` / `CLAUDE.md` are
  **generated** — edit `.rulesync/rules/` instead (see [Agent instruction files](#agent-instruction-files)).
- **Write an extension instead of changing core.** Skills, atom packs, and MCP servers are
  the supported extension surfaces and need no changes to the daemon. Two runnable atom
  packs live in [`packages/sdk-atom/examples/`](packages/sdk-atom/examples/): `echo` (the
  minimum viable pack) and `multi` (channel + command + provider + message type in one
  manifest). `monad atom scaffold <type> [dir]` generates a fresh one.

  Three packages — `@monad/protocol`, `@monad/sdk-atom`, `@monad/sdk-experience` — are the
  intended public authoring contract; everything else in `packages/` is internal and may
  change without notice. **None of them are on npm yet**, so an out-of-repo pack currently
  has to depend on them by path or git until the first publish lands; the examples above run
  inside this repo without that. `@monad/sdk-experience/react` is in-repo only: it re-exports
  `@monad/client-rtk` hooks for first-party host-component experiences, which render
  inside the web app's own Redux provider. Publishing is
  [`scripts/publish-npm.ts`](scripts/publish-npm.ts); run it with no flags for a build +
  `npm publish --dry-run` before changing anything it touches.
- **Tests.** The assertion rules in [docs/internal/development/testing.md](docs/internal/development/testing.md)
  are strict and mechanically enforced; adding a behavior test for an under-covered path is
  a well-defined, self-contained task.
- **Cross-platform verification.** CI runs Linux, macOS, and Windows, but real-machine
  reports — especially Windows and musl Linux — catch what CI does not.

Before starting anything large, open an issue or a
[Discussion](https://github.com/Monadix-AI/monad/discussions) so the direction can be
agreed before you spend time on it. For anything that changes a contract or adds a
subsystem, the expected first artifact is a proposal in
[`docs/internal/proposals/`](docs/internal/proposals/), not a pull request — see [ROADMAP.md](ROADMAP.md).

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/Monadix-AI/monad/issues/new/choose).
For anything security-related, **do not** open a public issue — follow
[SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
