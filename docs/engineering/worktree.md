# Worktree development

Audience: coding agents and human engineers working on a feature branch in a git
worktree. **Part 1** is the end-to-end feature workflow; **Part 2** is the environment
reference (ports, verification, gotchas) you reach for when something doesn't come up.
Every command assumes you are at the worktree root unless stated otherwise.

---

# Part 1 — Feature workflow

> **Rule: never develop in the main checkout.**
> All feature work — including single-file fixes — happens inside a dedicated git worktree
> on its own branch. Do not run `git checkout -b feat/…` inside the main checkout and
> start editing files there. The main checkout is read-only working state: you branch from
> it, you rebase against it, you merge into it — you do not code in it.

## 0. One-time machine setup

These steps are done once per developer machine, not per worktree.

### Bun version management (mise)

The repo pins its Bun version in `package.json` under `"packageManager"`. A shell
hook reads that field on every `cd` and switches Bun automatically — no extra
per-project files (`.bumrc`, `.mise.toml`, `.bun-version`) needed.

Full setup instructions with bash/fish variants: [CONTRIBUTING.md § Installing Bun
with automatic version switching](../../CONTRIBUTING.md#installing-bun-with-automatic-version-switching).

Short version for zsh:

```sh
brew install mise   # version installer only — do NOT run mise activate
```

Add to `~/.zshrc`, then restart your shell:

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

To upgrade the pinned version, bump `"packageManager"` in the root `package.json`.

## 1. Open a worktree and initialise the environment

```sh
# run from the main checkout — never from inside another worktree
git worktree add ../monad-<feature> -b <feature>
cd ../monad-<feature>
```

Then, without doing anything else first:

```sh
bun install        # link binaries + run postinstall (sets up .env.local with this worktree's ports)
bun run dev        # starts daemon + web on this worktree's ports
```

`bun run dev` is the **first thing you must run** in a fresh worktree — the `.dev/bin`
CLI shims hardcode absolute paths, and if they aren't regenerated for the new checkout
they silently run another worktree's source. `bun run dev` is safe to run in **every**
worktree at once; ports are assigned per worktree automatically. See [Part 2](#part-2--environment-reference)
for what it sets up, port discovery, and how to verify it came up.

Do not copy `.env.local` from another worktree — each checkout needs its own.

## 2. Develop and keep tests comprehensive

Write (or update) tests as you go, not as a last step.

Run all tests from the worktree root:

```sh
bun run test
```

When you know the change is confined to one package, you can scope it:

```sh
bun scripts/bun-test.ts packages/store/ --only-failures
bun scripts/bun-test.ts apps/cli/ --only-failures
```

Rules for test coverage:

- New behaviour → new test. There is no "too small to test".
- If you changed a code path that existing tests do not reach, add a case.
- Tests are hermetic — they must not depend on a running daemon or on `.dev/` state.
- **`apps/monad` specifically:** changes there must be exercised over both TCP loopback
  and the Unix socket. A test that covers only one transport is incomplete.

If `bun` exits with code 137 (OOM-killed by the sandbox), re-run with the sandbox
disabled — the test itself is correct, the sandbox is the problem.

## 3. Rebase onto main before merging

When development is complete and tests pass, bring the branch up to date:

```sh
git fetch origin
git rebase origin/main
```

If there are conflicts, resolve them, then:

```sh
git add <resolved-files>
git rebase --continue
```

After a clean rebase, run one failure-collection pass across the full quality gate
before fixing. The goal is to expose the complete lint, typecheck, and test failure
surface once, then make a concentrated repair pass instead of cycling through
test → fix → test → fix for one command at a time:

```sh
bun run typecheck       # TypeScript — must have zero errors
bun run lint            # Biome — auto-fixes style issues, then exits non-zero on remaining errors
bun run test            # all unit + e2e — must be green
```

If one command fails, record its failures and continue to the remaining quality-gate
commands when it is safe to do so. After the concentrated fix pass, re-run the same
gate and require all three commands to pass.

If the rebase exposed a type error or test failure that was not present before,
it is a real regression introduced by the merge of main — fix it in this branch,
do not suppress it.

## 4. Pre-merge audit

Before opening a PR, review the diff against each guideline document below.
Work through them in order; a finding in an earlier category often affects later ones.

| Category | Guideline document | What to check |
|---|---|---|
| Security | [security-guidelines.md](security-guidelines.md) | Injections, credential leaks, socket/CSRF exposure, untrusted input paths |
| Performance | [performance-guidelines.md](performance-guidelines.md) | Latency budget, memory, bundle size, hot-path allocations |
| Code style & typing | [conventions.md](conventions.md) | Single source of truth for types, no re-declarations, comment policy |
| Functional architecture | [engineering/architecture.md](architecture.md) | Package boundaries, allowed dependency directions, no cross-layer leaks |
| UI design | [design/ui-guidelines.md](../design/ui-guidelines.md) | Token usage, component patterns, accessibility, dark-mode |
| UX design | [design/ux-guidelines.md](../design/ux-guidelines.md) | Interaction model, copy tone, loading/error/empty states |

**Apply only the categories that are relevant to the diff.** A backend-only change
skips UI and UX; a pure CSS change skips architecture. When in doubt, include it.

For each finding: fix it before merging, or document why it is acceptable as a
follow-up (add a `TODO(issue-link)` comment in the code, open the issue, reference it
in the PR description).

## 5. Squash and merge into main

**Never merge with a full commit history from the worktree.** The feature branch
commits are working notes (WIP, fixup, "oops") and clutter the main log.

### Prepare the squash commit message

Decide on a single commit message that will appear in `main`'s history and in the
change log. The bar for what goes in:

| Include | Omit |
|---------|------|
| What changed and why (the user-visible effect) | "fix typo", "add comment", "WIP" |
| Breaking changes or migration steps | Internal refactors invisible to callers |
| Security fixes (even if small) | Implementation details that belong in code comments |

Format:

```
<type>(<scope>): <short summary under 72 chars>

<optional body — one paragraph, wraps at 80 chars>
<omit if the subject line is self-contained>
```

`type` is one of: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `chore`.

For breaking changes, append `!` after the type and add a `BREAKING CHANGE:` footer:

```
feat(protocol)!: rename SessionInit → SessionOpen

BREAKING CHANGE: all clients must update the handshake message type.
Old sessions using SessionInit will be rejected.
```

### Merge via GitHub (preferred)

1. Push the branch: `git push -u origin <feature>`
2. Open a PR against `main`.
3. On the PR, choose **Squash and merge**.
4. Edit the auto-generated message down to the single commit message above.
5. Confirm merge.

### Merge locally (when GitHub is not in the loop)

```sh
# from the main checkout, not the worktree
git checkout main
git merge --squash <feature>
git commit -m "<commit message as above>"
```

`--squash` stages all changes but does not commit, giving you control over the message.

### Clean up

```sh
git worktree remove ../monad-<feature>   # removes the directory
git branch -d <feature>                  # delete the local branch
git push origin --delete <feature>       # delete the remote branch (if pushed)
```

If `git worktree remove` fails because the worktree has untracked or modified files,
confirm the branch is fully merged, then use `--force`. Never force-remove a worktree
with uncommitted work you intend to keep.

---

# Part 2 — Environment reference

Read this when `bun run dev` fails or you need to find/verify this worktree's ports.

## What `bun install` + `bun run dev` do for you

1. **At install time**, `bun install` runs the root `postinstall` hook →
   `scripts/dev-init.ts`. It is idempotent (and a no-op in CI/production). It:
   - creates/migrates `.env.local` (sets `MONAD_HOME=<worktree>/.dev/.monad`),
   - **assigns this worktree its own ports** (derived from the checkout path) and writes
     them into `.env.local` if absent — it never clobbers a value you set by hand,
   - regenerates the `./.dev/bin` CLI shims with this worktree's absolute paths.
2. **At dev time**, `bun run dev` runs `scripts/dev-prep.ts`, which reads `.env.local`, mirrors
   `WEB_PORT` → `PORT` (Next.js only honors `PORT`/`-p`, not `WEB_PORT`), points Bun's
   runtime transpiler cache at a shared `~/.cache/monad-bun` (so `*.pile` files stop piling
   up in each worktree's `node_modules`), then starts `turbo`.
3. `turbo` starts `@monad/monad` (daemon) and `@monad/web` (Next dev) as persistent tasks.

Everything lives inside the worktree (`.dev/` is gitignored). Nothing global on the
machine is touched, so worktrees never share daemon state, sockets, or a database.

## Finding this worktree's ports

`postinstall` prints a summary, or read them directly:

```sh
grep -E '^(MONAD_PORT|WEB_PORT|MONAD_KV_UI_PORT)=' .env.local
```

| Var | What | Default range |
|---|---|---|
| `MONAD_PORT` | Daemon TCP port. Overrides `config.json`'s `network.port` for the daemon **and** its clients, so they stay in sync. | 52000–52999 |
| `WEB_PORT` | Next dev server port. | 3100–4099 |
| `MONAD_KV_UI_PORT` | Dev-only KV debug UI port. | 6400–7399 |

The daemon binds `MONAD_PORT`; the web app, TUI, and CLI all resolve the same value, so
in-worktree clients connect automatically. **Never hardcode `52749` or `3000`** — those
are only the fallbacks for a checkout that hasn't been set up.

## Verifying it came up

- Daemon: look for `monad daemon listening on http://127.0.0.1:<MONAD_PORT> …` on stderr,
  or probe it:
  ```sh
  curl -fsS "http://127.0.0.1:$(grep -E '^MONAD_PORT=' .env.local | cut -d= -f2)/" >/dev/null && echo daemon-up
  ```
- Web: Next prints `Ready` with the `http://localhost:<WEB_PORT>` URL. Open that port, not 3000.

## Gotchas

- **Never develop in the main checkout.** Create a worktree first; all edits, commits,
  and test runs happen inside it. The main checkout is for creating worktrees and merging
  — not for writing code.
- **Always run `bun install && bun run dev` in a freshly-created worktree before anything
  else.** The `./.dev/bin` shims hardcode absolute paths; if they aren't regenerated for
  the new checkout they point back at whichever worktree created them, silently running
  the wrong source.
- **`.env.local` is per-worktree and gitignored.** Don't copy one between worktrees — that
  copies the other worktree's ports and reintroduces the clash.
- **To pin a port** (e.g. an external tool expects a fixed daemon port), set it in that
  worktree's `.env.local`; `postinstall` will leave your value untouched.
- **Running the CLI (`monad`, `monad-tui`, …)** — use `bun monad <cmd>` (and
  `bun monad-tui …`); `bun` resolves the workspace bin from `node_modules/.bin`
  automatically, so no `PATH` setup is needed. `bun run dev` doesn't require them either.

## Why per-worktree ports (read on failure)

The daemon binds a TCP port **unconditionally** — the WebSocket push channel
(`/v1/stream`) is TCP-only, so the Unix socket alone can't serve the web UI. Two worktrees
on the same default port would mean the second daemon dies with `EADDRINUSE`. The Next dev
server (`WEB_PORT`) and the KV debug UI (`MONAD_KV_UI_PORT`) are the same story. Per-worktree
port assignment in `scripts/dev-init.ts` is what makes concurrent worktrees work; the
single `MONAD_PORT` env var (honored by both the daemon and every client) is what keeps
them pointed at each other without any manual bookkeeping.

See [runtime.md](../internals/runtime.md) for the full transport/binding model.
