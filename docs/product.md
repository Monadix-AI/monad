# Product

## Core idea

**Monad is a daemon-first agent team runtime with headless architecture.**

Models can reason. Agents can act. A team needs a runtime. Monad is the durable
operating layer that keeps agents available, governs what they can do, preserves
their work, and lets humans supervise them through interfaces shaped for the job.

- **Human intent, agent execution** — people own direction, judgment, and
  accountability; agents carry out work within explicit capabilities and policy.
- **The runtime owns continuity** — agents, tasks, collaboration state, artifacts,
  approvals, and audit history survive beyond any client window.
- **The experience follows the work** — the same runtime can be projected into
  interfaces designed for coding, research, operations, content, or another domain.
- **Autonomy is progressive** — responsibility expands only as identity,
  permissions, observability, recovery, and human approval make it safe to do so.

## Agent team runtime responsibilities

Monad exists to answer the operational questions behind an agent team:

1. **Who keeps the agents running?** A long-lived daemon operates independently of
   the Web UI, CLI, TUI, editors, APIs, and messaging channels.
2. **Who gives them identity, capabilities, and permissions?** The runtime resolves
   roles, model routes, skills, tools, credentials, sandbox boundaries, and approval
   policy.
3. **Who assigns and restores their work?** Runtime-owned sessions and task state
   support delegation, interruption, resumption, branching, and inspection.
4. **Who preserves collaboration state, artifacts, and audit history?** Agents and
   humans work from one durable source of truth instead of isolated transcripts.
5. **Who brings humans into approval decisions?** Tool calls cross an explicit
   approval boundary before high-risk actions execute.
6. **Who projects the same team into different work experiences?** Workspace
   Experiences tailor information architecture and controls without owning a second
   copy of runtime state.

Daemon-first and headless are therefore product properties, not only implementation
choices. Clients can close, reconnect, or be replaced without becoming the owner of
the agents or their work.

## Product forms

Monad exposes two product forms over one runtime:

### Monad Agent

The focused, single-agent form. Monad Agent gives an individual a direct working
relationship with one agent while retaining persistent context, controlled
capabilities, approvals, recovery, auditability, and access from every client
surface.

### Monad Mesh

The agent-team form. Monad Mesh coordinates multiple agents through explicit roles,
delegation, parallel work, shared context and artifacts, human approvals, and
recoverable collaboration state.

Monad Agent and Monad Mesh are not separate runtimes or data silos. They share the
same daemon, identities, policy, capability system, task state, storage, approvals,
and audit history. A user can begin with one agent and compose a team without moving
the work into another product.

## Workspace Experiences

A Workspace Experience is a scenario-specific projection of agents, tasks,
artifacts, approvals, and collaboration state from the shared runtime. It is more
than a theme, but it is not a separate application or source of truth.

- **Shared runtime, tailored experience** — every experience reads and acts on the
  same runtime objects.
- **Scenario-specific interaction** — coding may center repositories, diffs, and
  terminals; research may center sources, evidence, and reports; operations and
  content workflows can expose different structures and controls.
- **Composable and switchable** — Atom Packs can contribute experiences, and users
  can change the experience without migrating the underlying team or work state.

## Users

Three overlapping groups who share one runtime but may use different experiences:

1. **Everyday Agent users** — people who want a capable, approachable Monad Agent
   experience. Runtime and configuration complexity should stay out of their way.
2. **Developer power users** — engineers who run long-lived work, configure model
   providers and MCP servers, install Atom Packs, inspect tool events, and compose
   specialist agents. Information density and controllability matter.
3. **Team operators** — people who organize Monad Mesh teams, manage identity and
   approval policy, configure channels, recover tasks, and monitor collaboration.
   Observability, governance, and Workspace Experience customization are primary.

Context is local-first and spans several surfaces. The runtime may continue
working while the browser is closed, an editor is focused, or a channel is the only
active human interface.

## Product Purpose

The `monad` daemon runs Agent and Mesh workloads and exposes them through local APIs
and client surfaces. It keeps Monad-owned state local, binds loopback only by
default, and remains useful as both an approachable Agent product and a deeply
configurable team runtime. Requests to configured model providers still leave the
machine; the runtime, policy, credentials, and local state around those calls remain
under the user's control.

Success means a user can start with one agent, understand and approve what it is
doing, compose additional agents when the work benefits from a team, recover that
work after interruption, and choose an experience suited to the scenario without
splitting state across products.

## Product boundaries

Monad already provides the foundations of this model: a daemon/API boundary,
persistent sessions, Workplace collaboration, mesh-agent and ACP delegation,
peer federation, approval gates, activity records, and Workspace Experience
extensions. These are enabling primitives for Monad Mesh.

The product positioning does not claim that every Mesh contract is complete. In
particular, it does not imply arbitrary distributed scheduling, universal task and
artifact schemas, or cross-owner identity and trust. Cross-owner collaboration
remains Monadix territory. Product documentation must distinguish present
capabilities from the direction they support.

## Brand Personality

**Warm, capable, trustworthy.** Three words: *grounded*, *clear*, *crafted*.

The UI should feel like a great human collaborator who is also very good at their job: approachable, never cold or intimidating, but clearly competent. Not "fun" or "playful" for its own sake — warmth comes from quality, clarity, and an interface that respects the user's intelligence.

Emotional goals:
- For new users: *"This feels safe and easy to start."*
- For power users: *"This tool trusts me and doesn't get in my way."*
- For both: *"I can feel that real care went into this."*

## Anti-references

- **Cold terminal-only aesthetics** (raw dark glass, dense monospace everywhere) — alienates the non-technical half of the user base.
- **Generic AI chat SaaS** (white backgrounds, gradient text, identical card grids, hero-metric dashboards) — boring and forgettable; doesn't communicate developer-tool depth.
- **Cream / sand / warm-neutral AI scaffolding** (the 2024–2026 AI app default: beige body, tracked uppercase section eyebrows, numbered section markers) — the saturated AI reflex; looks generated, not designed.
- **Aggressive dark brand-first UIs** (red hero stripes, pure near-black everywhere, no warmth) — the design-system marketing aesthetic is right for a launch page, wrong for a product UI people live in.

## Design Principles

1. **Warm precision** — each experience should feel inviting without sacrificing
   information density and keyboard-first efficiency. Warmth comes from quality and
   care, not decorative friendliness.
2. **Progressive depth** — Monad Agent should be learnable without hiding the full
   depth needed to configure models, capabilities, Mesh roles, approval policy, and
   extension conflicts.
3. **Team state, clearly surfaced** — users should be able to see which agent is
   acting, which task it owns, what changed, which artifacts were produced, and
   where human judgment is required.
4. **One runtime, tailored experiences** — scenario-specific interfaces may differ
   substantially, but they must preserve shared identity, task, artifact, approval,
   and audit semantics.
5. **Continuity over client state** — closing or switching a client must not make
   the work disappear. Experiences reconnect to runtime-owned state.
6. **Earned craft** — every detail should feel intentional, not decorated. The
   interface earns trust through consistency, contrast, precision, and predictable
   behavior.

## Accessibility & Inclusion

WCAG AA minimum by convention (4.5:1 body text, 3:1 large/bold). Motion handled with `prefers-reduced-motion` support throughout — the init wizard already sets the standard. No formally scoped requirements beyond that.
