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

### Option A — GitHub Codespaces or Dev Container (zero local install)

Click **Code → Codespaces → Create codespace** on GitHub, or open the repo in
VS Code / Cursor and choose **Reopen in Container** when prompted. The container
comes with the right Bun version pre-installed and runs `bun install`
automatically on first start.

No local tooling required.

---

### Option B — direnv (recommended for local development)

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

### Option C — manual shell hook (no direnv)

If you prefer not to install direnv, add this to `~/.zshrc` (bash/fish variants
in [`docs/worktree.md`](docs/worktree.md)):

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
git clone https://github.com/monadix-labs/monad.git
cd monad
bun install              # installs deps and sets up git hooks (lefthook)
cp .env.example .env.local   # then fill in OPENROUTER_API_KEY
bun run dev              # daemon (@monad/monad) + web UI
```

The repo is a monorepo managed with Bun workspaces + Turbo:

- `apps/` — the daemon (`monad`), `cli`, `tui`, and `web` UI
- `packages/` — shared libraries (`@monad/*`: protocol, store, tools, …)

Dev data is isolated under `.dev/` (gitignored) — it never touches your real
`~/.monad`. See the [README](README.md) for the runtime/transport model.

## Required checks

Your change must pass all three before it can merge. CI runs the same commands
on Ubuntu, macOS, and Windows.

```bash
bun run typecheck    # turbo run typecheck
bun run test         # turbo run test (bun:test under the hood)
bun run lint         # biome check --unsafe
```

Most of this is also enforced locally by git hooks (lefthook), which on commit
run Biome, [syncpack](https://github.com/JamieMason/syncpack) (dependency
version consistency), and a staged typecheck. Don't bypass the hooks.

When you touch `apps/monad`, exercise the feature over **every transport**
(TCP loopback and the Unix socket) — the daemon's behaviour must match on both.

## Agent instruction files

The **repo-root** `AGENTS.md` is **generated** — don't hand-edit it. The single
source is [`.rulesync/rules/`](.rulesync/rules/);
[rulesync](https://github.com/dyoshikawa/rulesync) compiles it into `AGENTS.md`.
We commit **only `AGENTS.md`** — every major agent reads it natively or as a
fallback (Codex, Cursor, Copilot, Gemini, Claude Code, Zed, Roo, Warp, opencode,
Cline, Kiro, Antigravity), so the per-tool files (`CLAUDE.md`, `.cursor/rules/`,
`.github/copilot-instructions.md`, `GEMINI.md`) are redundant and not produced.

Edit the source, then regenerate:

```bash
bun run agents:sync     # regenerate AGENTS.md from .rulesync/
bun run agents:check    # verify it's up to date (CI runs this)
```

The lefthook pre-commit hook regenerates and stages it automatically when you
change `.rulesync/`. To give a specific tool its proprietary format (e.g. Cursor
`.mdc` glob scoping), add that target back in `rulesync.jsonc`.

**Per-package rules** are **hand-written**, not generated. A subpackage with its own
conventions carries a thin, package-specific `AGENTS.md` — read by Codex/Cursor/Gemini
via nearest-file precedence and by Claude Code as a per-directory fallback. Edit that
file directly; don't repeat repo-root rules. These live next to the code they govern,
outside rulesync's SSOT — intentionally. (If a tool ever fails to pick up a nested
`AGENTS.md`, drop a one-line `CLAUDE.md` containing `@AGENTS.md` beside it.)

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

Use the [issue templates](https://github.com/monadix-labs/monad/issues/new/choose).
For anything security-related, **do not** open a public issue — follow
[SECURITY.md](SECURITY.md) instead.

## License

By contributing, you agree that your contributions will be licensed under the
project's [MIT License](LICENSE).
