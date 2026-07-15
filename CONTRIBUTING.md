# Contributing to monad

Thanks for your interest in contributing! This guide covers the local setup,
the checks your change has to pass, and how we handle commits and pull
requests.

## Prerequisites

monad is a [Bun](https://bun.sh) project. The active Bun version is pinned in
`"packageManager"` in `package.json` and switched automatically — pick whichever
setup path fits your workflow.

- Git
- An [OpenRouter API key](https://openrouter.ai/keys) to run against a live model (`OPENROUTER_API_KEY`)

> Replace `node`/`npm`/`npx` with `bun`/`bun run`/`bunx` throughout.

---

### Option A — direnv (recommended for local development)

[direnv](https://direnv.net) reads the `.envrc` in the repo root and switches Bun
automatically on `cd`. The version is sourced from `"packageManager"` in
`package.json` and requires [mise](https://mise.jdx.dev) to download Bun binaries.

**1. Install direnv and mise** (one-time, global)

```sh
brew install direnv mise   # macOS
# Linux: https://direnv.net/docs/installation.html + https://mise.jdx.dev/getting-started.html
```

**2. Hook direnv into your shell** (one-time, global)

Add to your shell rc file and restart your shell:

| Shell | Command to add |
|-------|----------------|
| zsh   | `eval "$(direnv hook zsh)"` |
| bash  | `eval "$(direnv hook bash)"` |
| fish  | `direnv hook fish \| source` |

**3. Allow the repo** (once per clone)

```sh
cd monad
direnv allow
```

From this point on, `cd`-ing into the repo activates the right Bun automatically.
`cd`-ing out reverts PATH to what it was before. Output on entry:

```
direnv: loading .envrc
bun: 1.3.14
```

If the version isn't cached yet, `downloading` appears while mise fetches it.

> **Do not** run `mise activate` or add it to your shell rc — mise's `precmd` hook
> resets `PATH` on every prompt and will fight with direnv. mise is used here only
> as a version downloader.

---

### Option B — manual shell hook (no direnv)

If you prefer not to install direnv, add this to `~/.zshrc` (bash/fish variants
in [`docs/engineering/worktree.md`](docs/engineering/worktree.md)):

```zsh
_mise_auto_bun() {
  local pkg="$PWD/package.json"
  [[ -f $pkg ]] || return
  local ver
  ver=$(grep -o '"packageManager"[^"]*"bun@[^"]*"' "$pkg" 2>/dev/null | grep -o 'bun@[^"]*' | cut -d@ -f2)
  [[ -z $ver ]] && return
  echo "bun: detected $ver"
  local bun_bin="${MISE_DATA_DIR:-$HOME/.local/share/mise}/installs/bun/$ver/bin"
  if [[ ! -d $bun_bin ]]; then
    echo "bun: downloading $ver..."
    mise install "bun@$ver" || return
  fi
  path=("$bun_bin" ${path:#*mise/installs/bun/*})
  echo "bun: using $ver"
}
add-zsh-hook chpwd _mise_auto_bun
_mise_auto_bun
```

Requires `brew install mise`. Do **not** run `mise activate`.

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
bun install              # installs deps and sets up git hooks (lefthook)
bun run dev              # daemon (@monad/monad) + web UI
```

`bun install` is the one-step initializer. It creates `.env.local`, assigns stable
worktree ports, installs local shims and hooks, refreshes generated inputs, and starts
optional shared development services when their host tools are available. Run
`bun run dev:doctor` if any part of the environment is unhealthy.

The repo is a monorepo managed with Bun workspaces + Turbo:

- `apps/` — the daemon (`monad`), `cli`, `tui`, and `web` UI
- `packages/` — shared libraries (`@monad/*`: protocol, store, tools, …)

Dev data is isolated under `.dev/` (gitignored) — it never touches your real
`~/.monad`. See the [README](README.md) for the runtime/transport model.

## Required checks

Every commit runs the canonical quality gate in read-only mode. It never repairs or
stages files; any finding blocks the commit. Knip never deletes code automatically:
a finding blocks the commit until the source is intentionally changed.

```bash
bun run quality:precommit  # run every commit-time check without writing files
bun run quality:check      # CI/read-only quality checks
bun run test               # cross-package Bun tests
```

The quality gate covers Biome, syncpack, knip, dependency direction, agent-rule and
i18n generation, database history/drift, and workspace typechecking. CI runs the
same check definition, verifies it left the tracked checkout unchanged, and runs the
test suite on Linux, macOS, and Windows. Don't bypass the hooks.

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
bun run agents:check    # verify the local targets match the source
```

The quality gate regenerates these ignored local targets before checking them. To add
or remove a tool-specific target, edit `rulesync.jsonc`, not generated output.

**Personal rules** (just for you, never committed) go in `.rulesync.local/rules.md`;
`bun run agents:local` fans them into gitignored local slots (`CLAUDE.local.md`,
`.cursor/rules/*.local.mdc`) that layer on top of the shared files. See
[`.rulesync.local/README.md`](.rulesync.local/README.md).

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
and tags once that PR is merged — that PR is the human gate. **nightly** is fully
automatic: a daily job builds `main`'s tip (skipping if there are no new commits
since the last nightly) and publishes a rolling prerelease — no release PR, no
changelog churn. You never need a branch
just to release; the release build re-verifies the artifact with `test:install`
before publishing, so a momentarily-red `main` is recoverable.

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

## Reporting bugs & requesting features

Use the [issue templates](https://github.com/Monadix-AI/monad/issues/new/choose).
For anything security-related, **do not** open a public issue — follow
[SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
