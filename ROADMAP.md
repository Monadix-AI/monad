# Roadmap

Where Monad is going, and — just as importantly — where it is not. This page is a summary
of decisions already recorded elsewhere in the repo; each item links to the document that
owns the detail. It carries **no dates**: Monad is pre-1.0 and sequencing changes.

Product positioning and the boundaries behind these choices:
[docs/product.md](docs/product.md).

## Shipped foundations

These exist today and are documented as built, not planned:

- **Headless runtime** — the daemon owns state and behavior; Web, CLI, TUI, editors, and
  channels are replaceable clients ([contract](docs/internals/infra/headless-runtime-contract.md)).
- **Sessions and projects** — durable transcripts, branching, restore, project member
  identity and per-session bindings ([project-sessions](docs/internals/agent-team-runtime/project-sessions.md)).
- **Agent runtime** — tool loop, approval gate, layered context management, three-layer
  memory ([agent-runtime](docs/internals/agent-runtime/)).
- **Extensibility** — atom packs, skills, MCP, hooks, slash commands, workplace
  experiences ([atoms](docs/internals/infra/atoms.md)).
- **Collaboration** — mesh agents under provider adapters, ACP both directions, same-owner
  peer federation ([agent-team-runtime](docs/internals/agent-team-runtime/)).
- **Containment** — per-OS sandbox launchers, egress filtering, an optional VM backend
  ([sandbox-backends](docs/usage/sandbox-backends.md), [security-guidelines](docs/internal/development/security-guidelines.md)).

## In progress / next

**Trusted Workspace Experience contract (P1).** Close the gap between the shipped
web-only experience implementation and a supported local authoring contract: trusted
in-process React experiences with an optional daemon-side backend, atomic pack reload, and
a real failure boundary. Blocking prerequisite: the recorded
[management-isolation gap](docs/internals/agent-team-runtime/workplace-experiences.md#known-gap-management-isolation-is-not-enforced)
— an experience must not gain daemon authority merely by being selected as a rendering.
Detail: [proposal](docs/internal/proposals/headless-runtime-mesh-engine-priorities.md#p1--trusted-workspace-experience-contract).

**Sandbox hardening.** Per-platform gaps are tracked with severity in
[security-guidelines §8](docs/internal/development/security-guidelines.md#known-gaps--pending) —
notably that `net:'filtered'` is application-layer on Linux and Windows, and that
credential read-deny on Linux requires bubblewrap.

**VM backend conformance evidence.** The suites exist; what is missing is recorded
real-hypervisor runs on capable self-hosted runners.
[Evidence matrix](packages/sandbox-vm/docs/conformance.md).

## Design backlog — not authorized for implementation

**Distributed agent runtime (P2).** A future Gateway/Node split, device pairing and
revocation, NAT traversal, remote capability invocation, cross-machine artifact transfer,
workspace synchronization. Each needs its own reviewed specification first. The current
Mesh is deliberately **one daemon, one machine, one shared filesystem**.
[Backlog](docs/internal/proposals/headless-runtime-mesh-engine-priorities.md#p2--distributed-agent-runtime-design-backlog).

**Skill usage observability.** Capture per-skill activation counts and recency to drive
menu ordering and auto-load suggestions.
[Proposal](docs/internal/proposals/skill-observability.md).

**Parked ideas.** TOML configuration, a GraphQL endpoint, incognito run mode, dynamic
agent orchestration routing, provider key rotation policies — each with the reason it was
deferred and the minimum path back.
[Backlog ideas](docs/internal/proposals/backlog-ideas.md).

## Explicit non-goals

Recorded so nobody re-proposes them without new information:

- **Projects are not a scheduler.** Project collaboration coordinates agents; it does not
  become a task DAG, work-stealing queue, or lease/heartbeat domain.
- **Workplace Experiences are not a cross-client layer.** They render in the Web UI only.
  A capability that must exist everywhere belongs in the daemon.
- **No bundled inference engine.** Monad orchestrates model providers you choose.
- **No telemetry.** See [privacy](docs/usage/privacy.md).

## Influencing this

Roadmap items start as documents, not issues. A change of direction means a proposal in
[`docs/internal/proposals/`](docs/internal/proposals/) that states the contracts, migrations, and evidence
it needs. Discussion belongs in
[GitHub Discussions](https://github.com/Monadix-AI/monad/discussions); see
[CONTRIBUTING.md](CONTRIBUTING.md).
