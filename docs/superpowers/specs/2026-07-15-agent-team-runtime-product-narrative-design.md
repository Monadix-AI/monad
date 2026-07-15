# Agent Team Runtime Product Narrative Design

## Objective

Reposition Monad consistently across its primary product documentation as:

> **Monad is a daemon-first agent team runtime with headless architecture.**

The narrative must explain why agent teams need a durable runtime, distinguish
Monad Agent from Monad Mesh, and present Workspace Experiences as customizable
projections over one shared runtime rather than separate applications.

## Product Model

Monad is one runtime with two product forms and a customizable experience layer:

```text
Monad Runtime
|-- Monad Agent          Single-agent work
|-- Monad Mesh           Multi-agent team collaboration
`-- Workspace Experience Scenario-specific projection of shared runtime state
```

### Monad Runtime

The long-running daemon is the product foundation. It owns the durable state and
policy required to operate agents independently of any client interface:

- keep agents running;
- give agents identity, capabilities, and permissions;
- assign, pause, resume, and recover tasks;
- preserve collaboration state, artifacts, and audit history;
- bring humans into approval decisions; and
- expose the same agent team through different work experiences.

The daemon-first and headless properties are user value, not only implementation
details. A UI may close, reconnect, or be replaced without becoming the owner of
the agents or their work.

### Monad Agent

Monad Agent is the default form for individual and single-agent workflows. It
provides a focused working relationship with one agent while retaining the full
runtime foundation: persistent state, controlled capabilities, approvals,
recovery, multiple client surfaces, and auditability.

### Monad Mesh

Monad Mesh is the team form of the same runtime. It coordinates multiple agents
with explicit roles, delegation, parallel tasks, shared context, artifacts,
approvals, and recoverable collaboration state. It is not a separate runtime and
does not duplicate state owned by Monad Runtime.

Documentation must distinguish the Mesh product model from its current enabling
primitives. Sessions, Workplace, ACP delegation, peer federation, approvals, and
activity or artifact state support the direction, but the docs must not imply that
arbitrary distributed scheduling, cross-organization identity, or every recovery
contract is already complete.

### Workspace Experience

A Workspace Experience is a scenario-specific projection of the same agents,
tasks, artifacts, approvals, and collaboration state. It is not a skin and not an
isolated application.

Workspace Experiences follow three principles:

- **Shared runtime, tailored experience.** Experiences reuse runtime objects and
  never create a second source of truth.
- **Scenario-specific interaction.** Coding, research, operations, and content
  workflows may expose different information architecture and controls.
- **Composable and switchable.** Atom Packs may contribute experiences, and users
  can change the experience without migrating the underlying team or work state.

## Narrative Structure

The public narrative starts with the positioning statement, then defines the
runtime through the operational questions an agent team creates:

> Models can reason. Agents can act. A team needs a runtime.

The documentation then answers:

1. Who keeps these agents running?
2. Who gives them identity, capabilities, and permissions?
3. Who assigns and restores their work?
4. Who preserves collaboration state, artifacts, and audit history?
5. Who brings humans into approval decisions?
6. Who projects the same agent team into different work experiences?

The answer is the Monad daemon and its shared runtime services.

## Document Responsibilities

### `README.md`

The English product entry point. Establish the positioning above the fold, explain
the runtime responsibilities, introduce Monad Agent and Monad Mesh separately,
introduce Workspace Experiences, and update the architecture diagram from a single
agent to a team-oriented runtime.

### `README.zh-CN.md`

The Chinese product entry point. Preserve the meaning and hierarchy of the English
README without forcing a literal translation. Use the product names Monad Agent,
Monad Mesh, and Workspace Experience consistently alongside clear Chinese terms.

### `docs/product.md`

The source of truth for product purpose, product layers, audiences, runtime
responsibilities, Workspace Experience principles, boundaries, brand personality,
and product design principles.

### `docs/concepts.md`

The source of truth for precise concept definitions. Add Agent Team Runtime, Monad
Agent, Monad Mesh, Workspace, Workspace Experience, task, collaboration state,
artifact, approval, and audit relationships while preserving existing runtime,
extension, federation, and client-surface concepts.

### `docs/README.md`

The documentation map. Update entry descriptions so readers can find the new
product model without duplicating it.

## Language Rules

- Keep `Monad`, `Monad Agent`, `Monad Mesh`, and `Workspace Experience` capitalized
  as product concepts.
- Use `monad` only for executable, package, path, or repository identifiers.
- Prefer concrete runtime responsibilities over generic multi-agent claims.
- Describe Workspace Experiences as projections over shared durable state.
- Preserve local-first, security, approval, sandbox, transport, installation, and
  development information already present in the README files.
- Do not claim unimplemented distributed or cross-owner Mesh guarantees.

## Verification

After editing:

1. Confirm all five documents use the same positioning and hierarchy.
2. Check English and Chinese README sections for semantic parity.
3. Scan for high-prominence legacy wording that reduces Monad to one local agent.
4. Validate local Markdown links and heading anchors.
5. Review the diff to ensure no unrelated documentation or code changed.
