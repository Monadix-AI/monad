# Tools

monad's built-in tool set — the agent-reachable capabilities (fs, shell, process, net,
web-search/extract, email, code-exec, todo, memory, schedule, the delegation/model-derived
tools, and the MCP adapter). Every tool is reachable by the model, so **all tool inputs are
treated as hostile** (prompt injection): validation and resource guards run at call time, not
just in the schema.

Tools are **first-party**, not an atom kind: they ship with the daemon and are never contributed
by atom packs. The `Tool` type therefore lives in `apps/monad/src/capabilities/tools/types.ts`, not in the SDK
— tools do not go through `@monad/sdk-atom`. (The one SDK type a tool touches is
`ProviderToolHint`, for provider-native tool bindings such as Anthropic computer-use.)

## Layout

```
apps/monad/src/capabilities/tools/
  types.ts          Tool / ToolContext / backends — the authoring surface
  security.ts       call-time guards: assertPathWithinRoots, assertUrlAllowed, isBlockedIp
  schema.ts         Tool.inputSchema → JSON Schema for native function-calling
  invoke.ts         the single dispatch seam: gate + sandbox-root injection
  tool-catalog.ts   tool list → model-facing catalog text (revision-cached)
  path-gate.ts      path-escalation gating shared by fs/shell
  backends.ts       sandbox fs/terminal backends + shell config
  sandbox/          per-OS sandbox launchers + egress policy
  registry/         the tool implementations (one file or folder per tool)
    contract.ts     the uniform module contract (below)
    index.ts        manifests + builtinTools
    fs.ts shell.ts …
    email/          a tool with cohesive internal deps → same-named folder
      index.ts smtp.ts
    mcp/            the MCP adapter (exposes external servers' tools)
      index.ts oauth.ts oauth/
```

Infra shared by tools stays at the `tools/` root; only real tool implementations live under
`registry/`. A tool that needs cohesive internal modules gets a same-named folder (`email/`,
`mcp/`) instead of a flat file.

## The uniform module contract (`registry/contract.ts`)

EVERY tool module exposes the SAME entry — `export const register: ToolModule<Deps>` — a factory
that takes its dependency bag and returns the ready `Tool[]`. The *shape* is uniform; the deps
type is *parameterized* so each module declares exactly what it needs rather than sharing one
god-bag.

```ts
export type ToolModule<Deps = ToolDeps> = (deps: Deps) => Tool[];
export function buildTools<Deps>(modules: ToolModule<Deps>[], deps: Deps): Tool[]; // dedupes by name
export function only(tools: Tool[]): Tool;  // unwrap a single-tool module (e.g. tool_search)
```

Three tiers, one idiom:

| Tier | Modules | Deps | Notes |
|------|---------|------|-------|
| **static** | fs, shell, process, code-exec, net, web-search, web-extract, todo, email | `ToolDeps` (ignored) | composed at module load into `builtinTools` |
| **service** | memory, schedule | `ToolDeps` (`notes`, `scheduler`) | `return []` when a dep is absent → tool not advertised |
| **agent-runtime** | clarify, delegate, agent_delegate, vision, image, tts, skill, skill-manage, tool-call, tool-search | each its own `XxxDeps` | bootstrap-local deps: model, gate, context, `getTools`, … |

A module may keep an internal `createXxxTool` builder (several are imported directly by tests);
`register` is the one canonical entry that assembly goes through.

### Assembly

- **Static + service** → manifests in `registry/index.ts` (`staticModules`, `serviceModules`).
  `builtinTools` is `buildTools(staticModules, {})`. The barrel uses namespace imports (not
  `export *`) precisely because every module exports a symbol named `register`.
- **Agent-runtime** → composed in `bootstrap/agent.ts` with the live agent deps (model router,
  inbound-approval gate, context engine, the live `getTools` registry view, hook runner, …). The
  order is preserved so the prompt-cache prefix stays stable across turns.

Conditional tools opt out by returning `[]`: `email` when no backend is configured,
`agent_delegate` when there are no delegatable Studio agents at boot. Reflexive tools
(`delegate`, `tool_search`, `tool_call`) read a `getTools` thunk so they see the live registry —
including hot-installed atom-pack/MCP tools — without rebinding.

## Authoring rules

- **Declare `scopes` and `highRisk` honestly.** Gate dangerous, irreversible, or
  trust-boundary-crossing ops behind `needsApproval` (async; runs in the oversight gate).
  Absent gate + high-risk ⇒ denied (fail-closed).
- **Resource guards live in `run()` bodies**, not the schema: `assertPathWithinRoots`,
  `assertUrlAllowed`, `isBlockedIp`, path-traversal and egress checks. Never skip them on a
  path you believe is "trusted" — the argument is attacker-controllable.
- **Sandbox / credential wrapping is the daemon's job, not the tool's.** Don't reach for
  process/fs primitives that bypass the injected `ToolContext` constraints (`sandboxRoots`,
  `backends`).
- Tools are snapshotted by the agent at startup; a hot-installed tool registers into the live
  registry but only reaches the model through the live `getTools` view — don't assume a tool
  object captured at boot picks up mid-session changes.
- **Imports:** the `Tool` type comes from `@/capabilities/tools/types.ts`; the only SDK import a tool needs is
  `ProviderToolHint`. Otherwise `@monad/logger` is allowed. **Never** import
  `@monad/{monad,home,client}`.

See also [`security-guidelines.md`](security-guidelines.md),
[`performance-guidelines.md`](performance-guidelines.md), [`skills.md`](skills.md),
[`hooks.md`](hooks.md).
