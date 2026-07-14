# Web UI — Router Design

`apps/web` is a Next.js App Router SPA that is shipped as a **static export** (`next build` with `NEXT_OUTPUT=export`). The binary embeds the output and serves it alongside the daemon on a single port. This constraint shapes every routing decision described below.

---

## Route topology

```
/        → app/page.tsx      → <InitGate><Chat /></InitGate>
/init    → app/init/page.tsx → <InitPage />  (setup wizard)
```

Those are the only two URL routes. Everything else — active session, settings panel, settings section — is **React state**, not a URL segment.

---

## Core patterns

### 1. Client-side guard (`InitGate`)

`app/page.tsx` wraps `<Chat>` in `<InitGate>`. The gate calls `useInitStatusQuery()` and, if the daemon reports the workspace is not yet configured, calls `router.replace('/init')`.

```
/ visited
  └─ isLoading → spinner
  └─ !initialized → router.replace('/init')
  └─ initialized → render <Chat />
```

Rules:
- **Always use `router.replace`, never `router.push`**, so the browser's back button does not trap the user in a redirect loop between `/` and `/init`.
- Show a neutral spinner while the query is in-flight; never render the guarded content before the check resolves.

### 2. Post-setup redirect (`/init` page)

`/init` performs the mirror check: once `initialized` becomes true, it should bounce back to `/`. The policy lives in `lib/init-redirect.ts` as a **pure, testable function**:

```ts
export function shouldRedirectInitToHome(initialized: boolean, isDev = Bun.env.NODE_ENV !== 'production'): boolean {
  return initialized && !isDev;
}
```

- **Release builds** (`NODE_ENV === 'production'`): redirect immediately on completion — no reason to stay on the wizard.
- **Dev builds**: keep `/init` reachable even after setup so the wizard can be iterated on without resetting the workspace.

`NODE_ENV` is inlined by Next.js at build time, so the dead branch is eliminated in the static export.

Any redirect policy with environment-dependent behaviour must follow this pattern: extract to a pure function, unit-test both environments explicitly.

### 3. URL for anything the user expects to survive a refresh

**The rule:** if the user presses ⌘R and would reasonably expect to land back where they were, that state belongs in the URL — even if the destination is not shareable across machines.

"Not shareable" is not the same as "should not be in the URL." Sessions live on the local daemon and cannot be opened on another device, but a user absolutely expects `⌘R` on an open session to reopen that session, not drop them to an empty state.

| State | URL? | Implemented |
|---|---|---|
| Active session (`sess_123`) | **Yes** — `?s=<id>` | ✅ `chat.tsx` reads `searchParams.get('s')` |
| Settings panel open + tab | **Yes** — `?settings=<tab>` | ✅ `useNavigableModal('settings')` |
| Scroll position | No — browser `scrollRestoration` handles it | — |

**Session URL mechanics** (`chat.tsx`):
- `currentId` is derived directly from `searchParams.get('s')` — no `useState`.
- Selecting or creating a session calls `router.replace` with `?s=<id>` (and atomically removes `?settings=` in the same call, avoiding two separate replace calls).
- When a session is deleted and it was the active one, an `useEffect` detects the mismatch and clears `?s=` automatically.

**SPA fallback** (`server/index.ts`):
- Unknown paths now serve `index.html` (the SPA shell) instead of `404.html`, enabling deep-link navigation (e.g. future `/sessions/[id]` path segments, or direct URL-bar access to `/?s=sess_abc`).

**Using path segments vs query params** under `output: 'export'`:

Both work. Query params need no extra configuration. Path segments (`/sessions/[id]`) additionally require:
1. `export const generateStaticParams = () => []` in the page file.
2. The SPA fallback in `serveAsset` — already done.

With those two in place, `'use client'` + `useParams()` works exactly like a normal Next.js app.

### 4. Navigable modals — every panel must be URL-backed

Any view the user can navigate **into** must be representable in the URL, even if it cannot be shared across machines. The minimum requirement is that ⌘R (refresh) restores the open state.

**Hook:** `hooks/use-navigable-modal.ts`

```ts
const [tab, setTab] = useNavigableModal('settings');
// tab: null (closed) | 'models' | 'channels' | 'connection'
```

Behaviour:
- `setTab('models')` when currently `null` → `router.push` (back button will close)
- `setTab('channels')` when already open → `router.replace` (no history noise for tab switches)
- `setTab(null)` → `router.replace` (no history entry for the closed state)

**URL convention** — the param value IS the sub-state; absence means closed:

| URL | State |
|---|---|
| `/` | chat, no session |
| `/?s=sess_abc` | session open |
| `/?s=sess_abc&settings=models` | settings open on Models |
| `/?s=sess_abc&settings=channels` | settings open on Channels |

**Coordination** — two components can read the same param independently:
- `Chat` reads `settingsTab !== null` for the show/hide branch.
- `Settings` reads the same param for which tab to render and calls `setTab(id)` on tab clicks.
- Closing from inside Settings calls `setTab(null)` (passed as `onClose`).

**Suspense requirement** — any page component tree that uses `useNavigableModal` (which calls `useSearchParams()`) must have a `<Suspense>` ancestor at the page level. `app/page.tsx` already has this.

**What goes in the URL vs stays in state:**

| UI state | URL? | Why |
|---|---|---|
| Panel/modal open + which view | Yes | Survives refresh; back closes it |
| Tab within panel | Yes | Survives refresh |
| Inline expand (e.g. provider card) | No | Micro-interaction; losing it on refresh is fine |
| Inline form open (add provider, add channel) | No | Transient; starts empty on refresh anyway |
| Skill autocomplete menu open | No | Input-driven, always reconstructed |

### 6. Lazy-loading heavy panels

Settings sections (`ModelSettings`, `ConnectionSettings`, `ChannelsSettings`) are loaded with `next/dynamic` and `ssr: false`:

```ts
const Settings = dynamic(() => import('./settings').then((m) => m.Settings), { ssr: false });
```

Apply this to any panel that:
- Is not on the initial render path.
- Imports substantial dependencies (form libraries, charting, etc.).
- Does not need to be included in the static export's initial JS bundle.

### 7. No `middleware.ts`

Next.js Middleware runs at the Edge and executes **before** the static files are served, which is incompatible with `output: 'export'`. Never add a `middleware.ts` to `apps/web`. All routing guards must be client-side React effects.

---

## API proxy

The web app talks to the daemon at `/api/*`. How the proxy is wired differs by environment:

| Environment | Mechanism |
|---|---|
| `next dev` | `rewrites()` in `next.config.ts` → `http://127.0.0.1:<port>/:path*` |
| Static export (binary) | `Bun.serve()` in `server/index.ts` proxies `/api/` at request time |
| Standalone `monad web` | Same `server/index.ts`, daemon URL read from `config.json` |

The dev proxy reads the daemon port from `MONAD_PORT` first, then `config.json`. This must match the precedence used by the daemon itself (see `apps/monad/src/main.ts`) or HMR will proxy to the wrong port in a multi-worktree setup.

---

## Decision guide

| Question | Answer |
|---|---|
| Do I need a new URL? | If the user presses ⌘R and would reasonably expect to land back in the same place — yes, use a URL. |
| Guard logic: where does it live? | In a client component at the top of the page, using `useEffect` + `router.replace`. |
| Redirect: `push` or `replace`? | Always `replace` for guards and post-action auto-redirects. Only `push` for explicit user navigation to a new context. |
| Active session: URL or state? | URL (query param `?s=<id>`). Refresh must restore the session. |
| Ephemeral panel open/close: URL or state? | State. Closing on refresh is acceptable. |
| Path segments vs query params for local entities? | Both work. Query params: zero server changes. Path segments (`/sessions/[id]`): add `generateStaticParams = () => []` + fix `serveAsset` to fall back to `index.html`. |
| Environment-branching redirect policy? | Extract to a pure function in `lib/`, inject `isDev` as a parameter, unit-test both branches. |
| New heavy panel? | `next/dynamic` + `ssr: false`. |
| Middleware? | Never. Static export does not support it. |
