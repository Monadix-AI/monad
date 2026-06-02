# Conventions

Code-level and typing habits that apply everywhere in this repo. Rationale lives here;
the short version is in [AGENTS.md](../AGENTS.md).

---

# Code style

## Comments

Write no comments by default. The only comment worth writing is one that explains **why**
something is done in a way that would surprise a reader — a hidden constraint, a subtle
invariant, a workaround for a specific bug, a non-obvious interaction with a tool or
runtime.

**Never write:**

- Narration of what the code does (`// Open DB`, `// 1. Ensure initialized`). Well-named
  identifiers already say that.
- Step numbers or phase labels (`// 1.`, `// 2.`, `// Step: ...`). Structure the code
  to be self-evident instead.
- Section-divider banners (`// ── Foo ──────────`). A blank line or a well-named
  function achieves the same.
- References to the task, fix, or caller ("added for the Y flow", "used by X"). Those
  belong in the commit message; they rot as the codebase evolves.
- Multi-line doc blocks that restate the signature or say what the function does.

**Write only when:**

The design or implementation is counter-intuitive — i.e. a competent reader would
reasonably reach for a different approach and get it wrong. Explain the constraint, not
the mechanics.

```ts
// tsgo emits this path into dist/main.d.ts; the @/ alias is internal and
// would not resolve for consumers reading the generated .d.ts.
import { createTransport } from "./transports/http";
```

```ts
// NODE_ENV branches are dead-code-eliminated by the bundler's `define`.
// Dynamic import inside the branch keeps the dev module out of the release binary.
if (Bun.env.NODE_ENV === "development") {
  const { startDebugUi } = await import("./debug-ui");
  startDebugUi();
}
```

## File length

No hard line limit, but a file that grows past ~300–400 lines is a signal to split.
Split along natural seams: one concept, one abstraction, one layer per file. A long
`main.ts` that boots everything is a smell — extract named initialisation functions
into focused modules.

## Abstraction and reuse

Extract a shared abstraction when the same shape appears in two or more places and
a change to the logic would otherwise require editing each copy. Don't extract
speculatively.

- **Extract when the second copy appears**, not the first.
- **Name the abstraction after what it does**, not where it came from.
- **Colocate** the abstraction with its consumers if it is only used within one package;
  promote to a shared package only when it crosses a package boundary.

## Async concurrency

When two or more `await` calls have no data dependency between them, run them
concurrently with `Promise.all` rather than awaiting them in sequence.

```ts
// ✗ serial — each waits for the one before it, with no reason to
const cfg  = await loadConfig();
const auth = await loadAuth();

// ✓ parallel — both reads fire at once
const [cfg, auth] = await Promise.all([loadConfig(), loadAuth()]);
```

A guard that short-circuits on the first result is not a dependency — move it after the
`Promise.all`:

```ts
// ✗ guard forces serial even though both loads are independent
const cfg = await loadConfig();
if (!cfg) return;
const auth = await loadAuth();

// ✓ load in parallel, guard afterwards
const [cfg, auth] = await Promise.all([loadConfig(), loadAuth()]);
if (!cfg) return;
```

Only keep awaits sequential when a later call genuinely needs the return value of an
earlier one.

## Configuration vs environment variables

Don't add new environment variables for feature configuration. Each category has
a designated home:

| What | Where |
|------|-------|
| User-facing settings (tool backends, search providers, email, …) | `config.json` via `@monad/home` |
| Daemon startup flags | `--flag` CLI arguments |
| Platform/OS path conventions (`APPDATA`, `XDG_CACHE_HOME`, …) | Environment variables |
| Build-time injected values (`NODE_ENV`, `NEXT_PUBLIC_*`) | Environment variables |

Environment variables are invisible to users — they don't appear in the UI or
`--help`, can't be validated at startup, and aren't surfaced in bug reports. Every
new env var for a feature is a hidden knob. Put configuration somewhere the user
can find and change it.

---

# Typing

Rules for where types live and how they flow through the monorepo. The goal: every
shape has exactly one producer, and runtime boundaries are validated, not trusted.

## 1. Single source of truth

Every type has exactly one producing module. Consumers **import** — they never
redeclare, copy, or hand-mirror a shape.

- Need a variation? Derive it: zod `.extend()` / `.pick()` / `.omit()`, or TS
  `Pick` / `Omit` / intersection (`&`).
- If you find yourself re-typing fields that exist elsewhere, you are at the wrong
  layer — import and derive instead.

## 2. Proximity + layer ownership

Types are defined where the data is **produced**, and data-layer vs UI-layer types
are kept strictly apart:

| Layer | Lives in | Examples |
| --- | --- | --- |
| Wire contract / domain | `@monad/protocol` | `Session`, `ChatMessage`, `ProviderView`, request/response shapes |
| Config / auth files | `@monad/home` | `MonadConfig`, `Credential` |
| DB rows | `@monad/store` | drizzle `$inferSelect` rows, mapped **back to** protocol types |
| UI view-models, component props, form state | the UI package/app that renders them | `ModelSettings` / `ProviderDetail` in `@monad/client-rtk`, form interfaces in `apps/web` components |

- UI-layer types compose data-layer types (`Pick`/`Omit`/`&`) — they are **never
  pushed up into `@monad/protocol`**.
- Conversely, `@monad/protocol` must contain no UI concepts. The `*View` shapes
  there are server-produced API response shapes (data layer), not UI types.
- Endpoint-local schemas (path params, query coercion) live with the contract
  wiring in `packages/protocol/src/http.ts`.

## 3. Schema-first at runtime boundaries

Anything parsed from outside the process — HTTP, WebSocket, disk — is defined as a
zod schema, and the TS type is inferred from it:

```ts
export const sessionSchema = z.object({ ... });
export type Session = z.infer<typeof sessionSchema>;
```

- The schema **is** the definition. Never maintain a hand-written interface next to
  a schema of the same shape.
- At the boundary, always `schema.parse(...)` — never `as` cast external data.
- Reference implementations: `packages/protocol/src/domain.ts`,
  `packages/home/src/config.ts`.

## 4. Pure TS is fine without a boundary

In-process-only types (e.g. `Principal`, `Task`, event payload shapes) stay as
hand-written interfaces. Don't wrap them in zod for its own sake — convert them to
schema-first when they actually gain a wire boundary.

## 5. Naming & body/params splits

- Schema: `xxxSchema` (camelCase); type: same stem in PascalCase (`sessionSchema` /
  `Session`).
- When part of a request travels in path params, the **full logical request schema
  is the truth** and the HTTP body derives from it:

```ts
export const addCredentialRequestSchema = z.object({ providerId: ..., label: ..., ... });
export const addCredentialBodySchema = addCredentialRequestSchema.omit({ providerId: true });
```

## 6. Documented exceptions

These shapes can't round-trip through `z.infer`, so the type stays hand-written and
the schema is annotated/cast to match — keep type and schema adjacent:

- **Template-literal ID types** (`` `ses_${string}` ``): hand type + regex schema +
  cast, in `packages/protocol/src/ids.ts`.
- **Open string unions** (`MessageType = '...' | (string & {})`): hand type,
  schema is `z.ZodType<MessageType> = z.string()`.
- **Native enums** (`ModelProviderType`): kept as a TS enum for dot-access
  ergonomics; schemas use `z.enum(KNOWN_PROVIDER_TYPES)`.

## 7. No consumer-side redeclaration

Apps (`web` / `tui` / `cli`) and client packages import type names from
`@monad/protocol` (or the owning data-layer package) only. If a shape you need
doesn't exist, add it to its producer — not to the consumer.

## 8. Per-module `types.ts` — export threshold and file layout

**Co-locate first, barrel-export second.** Define types in the file where the
producing code lives (handler, parser, schema). A `types.ts` at the module root
re-exports public names; it is a barrel, not a definition site.

**Export a type when at least one of the following applies:**

| Condition | Example |
| --- | --- |
| **Runtime boundary** | Any shape derived from a zod schema at HTTP / WS / disk — already required by rule 3; listed here for completeness. |
| **Consumer must annotate** | A consumer writes a function signature, callback type, test stub, or `satisfies` / `implements` constraint that names the type explicitly. |
| **Cross-package reference** | The type crosses a `@monad/*` package boundary — inference from another package is not possible. |

If none of these applies, keep the type as an unexported file-level `type` / `interface`.
If a consumer can write `ReturnType<typeof fn>` or let TypeScript infer, that is preferred
over adding a named export that widens the module's public surface.

**Modules with a runtime boundary split into two files:**

```
src/foo/
  schemas.ts   # zod definitions + z.infer<> exports — parsed at the boundary
  types.ts     # pure-TS domain/in-process types (omit the file if nothing qualifies)
```

The two files import each other as needed. Never write a hand-crafted interface
that duplicates a shape that already has a zod schema.

---

# Audited exceptions — do not re-flag

These were checked against the actual code and judged correct as-is. Recorded so a
future review doesn't re-raise them.

**Verified false positives:**

- **"Unix socket has no chmod"** — false. `apps/monad/src/main.ts` calls
  `chmod(sockPath, 0o600)` immediately after `Bun.serve({ unix })`; the socket's
  filesystem perms ARE its auth.
- **"`apps/web` uses Next.js → violates no-vite"** — false. It's a deliberate, documented
  choice ([web-router.md](web-router.md)): `apps/web` is a Next.js App Router SPA shipped
  as a static export embedded in the binary. The "Bun.serve + HTML imports" rule targets
  simple frontends.

**Intentionally not extracted:**

- **`kv/commands.ts` arg guards** — the repeated
  `if (args.length < N) return encodeError('wrong number of arguments')` is an idiomatic
  guard clause, not duplicated *logic*. A `null`-returning helper makes each guard 2 lines;
  a throw-based one adds exception control-flow to a RESP wire handler. Net-negative. Leave
  as-is. The abstraction rule targets duplicated logic, not guard clauses.
