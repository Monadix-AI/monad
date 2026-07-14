# Project Presets — decoupling project UI from project data

> Status: **implemented (as "workspace experiences")** — shipped as the workspace-experience seam:
> `@monad/sdk-experience` (host-API contract + web-component event bridge, recorded in
> `docs/engineering/architecture.md`), the `workspace-experience` atom kind in `@monad/protocol`,
> and the renderer/registry in `apps/web/src/features/workplace/experiences/`. Scope was: let one project's data be rendered by
> different, swappable, full-page UI "presets" chosen per use-case (chat-first, flow-first, …),
> with third parties shipping new presets as atoms.
>
> **Framing (locked):** a preset is **client-side reskinning, nothing more.** It is pure UI over
> the existing data interface — it never participates in business logic, never reshapes or owns
> data, never holds secrets. The *only* thing that persists is which preset a session uses
> (remembered across switches). Because a preset is pure presentation with no business reach,
> third-party presets are treated as trusted UI modules gated by the existing atom-install
> consent — **no bespoke isolation layer (no iframe/CSP/wire protocol).** The data layer is
> already UI-agnostic; this doc formalizes the seam, adds preset selection/persistence, and
> refactors today's hard-coded workplace layout into the first preset.

## 0. Why this is mostly a formalization, not a rebuild

A "project" is a Monad session titled `Workplace: <slug>`. `useProject(projectId)` in
`apps/web/components/workplace/use-project.ts` already returns a `ProjectController` in which
**every real value is session-backed or live-streamed** — messages, participants, activity,
tasks, approvals, workdir, moderator, model profiles, invite backends, and the action callbacks
(`sendDirective`, `resolveApproval`, `approveAll`, `pauseAll`, `switchProject`, invite/remove).
The only UI-only state it holds is `projectTab` and `inviting`.

So the UI⇄data boundary already exists — it just isn't treated as a contract. What is actually
coupled is the **presentation**: `apps/web/components/workplace/Workplace.tsx` hard-codes one
layout (left `ProjectRail`, `ProjectHeader`, a `chat | activity` tab switch, `Composer`, right
`AgentTasksRail`). This proposal turns that one layout into one of several swappable presets.

## 1. Decisions (locked)

| Dimension | Decision |
|---|---|
| **Decoupling seam** | The existing `ProjectController` (data + action callbacks) IS the contract. Presets render against it; they never read/write sessions directly. |
| **What a preset owns** | **Only the conversation canvas** — the data→UI mapping of the chatroom (how messages / activity / tasks / participants are visualized) plus sending a message. A preset is presentation; it does **not** implement management features. |
| **What the host owns** | All **project-management** affordances — member/agent management (invite/remove), moderator selection, approvals resolution, workdir, and the preset switcher. Host-rendered, **identical across every preset.** |
| **Preset granularity** | **Full canvas takeover inside a fixed host frame.** The preset takes over the whole conversation region (chat stream, flow graph, …); the host wraps it with a uniform management frame. Not a general composable-slot system — exactly one preset-owned region. |
| **What persists** | Only `session.origin.ext.presetId` — which skin this session uses. Nothing else. Per-session, remembered on switch, synced across clients via the session stream (the ext bag already carries `workplaceProjectModeratorAgentId`). |
| **Switch mechanism** | A `preset: { id, set(id) }` member on `ProjectController`, mirroring the existing `moderator`/`workdir` setters → `updateSession({ origin: { …, ext: { …, presetId } } })`. |
| **Default + fallback** | Unset → `'chat'` (backward compatible). A persisted id missing from the registry (atom uninstalled) → fall back to `'chat'` + non-blocking notice. |
| **Built-in presets** | `chat` (today's layout, extracted verbatim) and `flow` (new, react-flow), compiled into `apps/web`. |
| **Third-party presets** | A new `view` atom kind that exports a React preset component. The web app lazy-loads and registers it like any built-in. No isolation layer — see §6. |
| **One path for all presets** | Built-in and third-party presets are the same thing: a `PresetComponent` taking the `ProjectController` prop. No separate "brokered" path. |
| **Security posture** | A preset is pure UI with no business/data/secret reach beyond the sanctioned `ProjectController`, so the threat surface is "a bad skin renders badly." Trust = the existing atom-install consent gate. No new security machinery. |

## 2. The contract — `ProjectCanvas`

The preset does NOT receive the full `ProjectController`. The host splits the controller into
two halves and hands the preset only the canvas half — so a preset is **structurally incapable**
of doing management, not merely discouraged from it.

```ts
// What the host keeps for its own management chrome (full controller, unchanged).
type ProjectController = /* existing: data + ALL actions */;

// What a preset receives — the chatroom data projection + the one interaction it owns.
interface ProjectCanvas {
  // display data (read-only projection of the chatroom)
  messages: Message[];
  participants: Participant[];
  activity: ActivityRow[];
  tasks: AgentTask[];
  approvals: ApprovalView[];      // display only; resolving them is host chrome (see §4)
  typing: TypingIndicator | null;
  contextUsage?: ContextUsage;
  firstItemIndex: number;
  loadOlder: () => Promise<void>;
  // the only write a preset owns: post a message to the room
  sendDirective: (text: string) => Promise<void>;
}

interface ProjectView {
  canvas: ProjectCanvas;
  t: TFn;
  embedded: boolean;
}
type PresetComponent = (view: ProjectView) => ReactElement;
```

`ProjectCanvas` is derived from `ProjectController` by the host (`pick` the display fields +
`sendDirective`). Management actions — `inviteAgent`/`removeInvited`, `setModeratorAgentId`,
`resolveApproval`/`approveAll`, `setWorkdir`, `pauseAll`, `switchProject`, `preset.set` — are
absent from the preset's props by construction; only the host chrome calls them.

**Invariant (the whole point):** a preset MAY derive any view-model from `canvas` (chat → a flat
message list; flow → nodes/edges from `activity`/`tasks`/delegations) but has no path to sessions,
settings, or management actions. Consequences:

- Swapping a preset never touches data or management; changing either never touches a preset.
- If a preset needs more display data, we extend `ProjectCanvas` (shared — every preset benefits),
  never widen it with a management action.

`ProjectCanvas` is the published surface every preset (built-in or atom) depends on. Adding
display fields is backward-compatible; removing/renaming one is a breaking change for all presets.

## 3. Registry, selection, switching

```ts
interface PresetDefinition {
  id: string;                  // 'chat' | 'flow' | 'atom:<pack>:<id>'
  label: string;               // i18n key
  icon?: string;               // lucide name
  description?: string;
  source: 'builtin' | 'atom';
  atomName?: string;
  render: PresetComponent;     // a React component over ProjectCanvas — same for builtin + atom
}
```

- `PresetRegistry` merges built-ins (static array in `apps/web`) with atom-contributed presets
  discovered at runtime — the same builtin+discovered merge channels/commands already use.
- **Persistence:** read `presetId` off `currentSession.origin?.ext?.presetId`; write via a new
  `setPreset` callback that mirrors `setModeratorAgentId` in `use-project.ts`:
  ```ts
  const setPreset = useCallback(async (id: string) => {
    if (!currentSession?.origin) return;
    const ext = { ...(currentSession.origin.ext ?? {}), presetId: id };
    await updateSession({ id: currentSession.id, origin: { ...currentSession.origin, ext } }).unwrap();
  }, [currentSession, updateSession]);
  ```
  Expose as `preset: { id: presetId ?? 'chat', set: setPreset }` on the controller.
- **Switcher UI:** a segmented control in the cross-preset chrome (a thin host-owned strip, see
  §4) listing `registry.list()`; selecting calls `project.preset.set(id)`.

## 4. Refactor — `Workplace.tsx` becomes a `PresetHost` (management frame + canvas)

```
PresetHost (was Workplace.tsx)  — holds the full ProjectController
  ├─ management chrome (host-rendered, uniform across presets):
  │    member/agent management · moderator selector · approvals control
  │    · workdir · preset switcher · pause
  └─ canvas region:
       <entry.render canvas={toCanvas(controller)} t={t} embedded={embedded} />
```

- The host derives `canvas = toCanvas(controller)` (display fields + `sendDirective`) and passes
  only that to the active preset. It keeps the full controller for its own management chrome, so
  member management, moderator, approvals resolution, and workdir look and behave the same
  regardless of which preset is active.
- **chat preset:** move today's message stream + composer (`ChatTranscript`/`ActivityLog` view +
  `Composer`) into `presets/chat/ChatPreset.tsx`. The `chat | activity` tab (`PROJECT_TABS` in
  `types.ts`) stays an internal concern of this preset. Management bits currently inside
  `ProjectHeader` (workdir, moderator, approvals counter) move OUT to the host chrome — that's the
  one behavioral move in P0; the conversation rendering is verbatim.
- The host frame is a fixed, thin surround (a header/toolbar + optional rails); the preset owns
  the dominant conversation region and may lay it out freely (stream, graph, board, …).

### 4.1 `flow` preset (second built-in)

`presets/flow/FlowPreset.tsx`, reusing the existing react-flow infra
(`apps/web/components/GraphView.tsx`, `AgentLoopInspector.tsx`, `HookFlow.tsx` are precedent):

- **Nodes:** participants/agents (`project.participants`/`railAgents`) + tool steps derived from
  `project.activity` / `project.tasks` / running delegations.
- **Edges:** delegation/`agent_acp_delegate` relations; sequence between tool steps.
- **Interaction:** click a node → its message/output; the composer still drives
  `project.sendDirective`. Same data, flow-first projection — proves the contract with a
  genuinely different layout.

## 5. Routing & mount (unchanged surface)

No routing change needed. `WorkspaceRoute.tsx` still mounts `<Workplace … projectId=… />` for a
channel id; `Workplace` (now `PresetHost`) picks the preset internally from the session's
`origin.ext.presetId`. A preset choice is project state, not a route — so deep links stay
`/channels/<slug>` and the preset travels with the session across clients. (A transient
`?preset=` override could be added later for preview, but is out of scope.)

## 6. Third-party presets — the `view` atom kind

A third-party preset is the same thing as a built-in one: a `PresetComponent` over
`ProjectController`. The only new infrastructure is a way to ship and register one from an atom.

- Add `view` to `atomKindSchema` (`packages/protocol/src/atom-pack.ts`). The other 10 kinds run
  daemon-side; `view` is the first whose payload is browser React.
- sdk-atom factory: `defineProjectPreset({ id, label, icon, render })` where `render` is the
  `PresetComponent`. The atom's bundle is served to the web app, which **lazy-loads it and adds
  the returned `PresetDefinition` to the `PresetRegistry`** — exactly like a built-in, just
  discovered at runtime.
- **No isolation layer, by decision.** A preset only ever sees `ProjectController`; it has no
  path to sessions, tokens, the network, or other atoms beyond the sanctioned actions it calls on
  the controller. The worst a broken/hostile preset can do is render badly inside its own view.
  That risk does not warrant an iframe, a wire protocol, or a CSP carve-out — it would be
  over-design for a skin.
- **Trust = the existing gate.** Atom install already shows declared kinds + the static scan
  warnings and requires explicit consent (`apps/monad/src/atoms/install/*`). A `view` atom rides
  that same default-deny pipeline; installing one is the user's "I trust this UI" decision, just
  like installing a channel or command atom today.

> If a future requirement ever lets presets reach beyond `ProjectController` (e.g. their own
> network calls or storage), revisit isolation then. As specified — pure UI over a fixed
> interface — it is unnecessary.

## 7. Build phases

| Phase | Deliverable | Risk |
|---|---|---|
| **P0** | Extract `chat` preset (verbatim, zero behavior change); `Workplace` → `PresetHost`; built-in `PresetRegistry`; `ProjectView` contract. | Low — pure refactor. |
| **P1** | `presetId` in `origin.ext` + `project.preset.{id,set}` + host switcher + fallback; add the `flow` built-in preset. | Medium — **delivers the chat/flow switch end-to-end.** |
| **P2** | `view` atom kind + `defineProjectPreset`; web app lazy-loads + registers an atom preset like a built-in (no iframe, no protocol). | Medium — third-party presets, riding the existing install-consent gate. |

P0–P1 are immediately useful and low-risk and deliver the user-facing scenario. P2 only adds a
discovery/registration path for atom-shipped presets — no new runtime isolation.

## 8. Open questions

- **Host chrome split:** does the preset switcher live in a host-owned strip, or inside each
  preset's own header (host renders nothing)? Leaning host-owned strip so switching is always
  reachable even if a preset's header misbehaves.
- **Per-preset state:** `projectTab`-like UI state is currently in `useProject`. Such pure
  presentation state should move into each preset (so the controller holds only data + actions).
  Likely done during P0.
- **Preset-declared data needs:** should `PresetDefinition` declare a `requires` set of controller
  fields for graceful degradation / capability messaging? Cheap to add; defer until a preset needs it.
