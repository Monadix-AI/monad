---
title: "Product Principles"
description: "Apply Monad's product, brand, evidence, and accessibility constraints when designing user-facing experiences."
---
This developer-facing document records the product, brand, evidence, and accessibility constraints that guide Monad design work. Use [What Monad is](/product) for the user-facing product explanation.

## Product purpose

Monad exists to operate agent teams across replaceable clients and execution engines. The daemon preserves continuity, policy, collaboration, and human oversight while interfaces adapt to the work.

Success means a person can start with one agent, understand and approve its actions, add specialist agents when needed, recover work after interruption, and change clients without splitting state across products.

## Audiences

Three groups share the runtime but need different levels of detail:

1. **Everyday users**: need a focused first-party Agent experience without initial runtime configuration overhead
2. **Developer power users**: configure providers, skills, MCP servers, Atom Packs, sandboxes, approvals, and external runtimes
3. **Team operators**: manage team identity, policy, recovery, observation, channels, and Workplace Experiences

Progressive disclosure must serve all three groups without hiding the runtime controls required for accountable autonomy.

## Product principles

1. **Human intent, governed execution**: people own direction, judgment, and accountability; agents act within explicit capability, containment, and policy boundaries
2. **Continuity over client state**: closing, reconnecting, or switching a client must not discard work or transfer runtime authority
3. **One runtime, tailored experiences**: scenario-specific interfaces may differ while preserving shared identity, session, task, artifact, approval, and audit semantics
4. **Execution-engine independence**: the bundled Agent Runtime and external runtimes participate in the same team without creating separate policy or collaboration stores
5. **Progressive depth and autonomy**: an approachable default experience must not hide configuration, observation, recovery, or controls from operators
6. **Team state, clearly surfaced**: people must be able to identify the acting agent, owned work, produced artifacts, relevant changes, and pending human decisions

## Brand commitments

Monad should feel grounded, clear, crafted, warm, capable, and trustworthy. Warmth comes from quality, clarity, and respect for the person's intelligence rather than decoration.

Avoid these directions:

- Cold terminal-only aesthetics that exclude non-technical users
- Generic AI chat patterns that hide runtime and developer-tool depth
- Repetitive cream or sand scaffolding with tracked uppercase labels and numbered sections
- Aggressive brand-first interfaces that compete with sustained work

The Monad name and existing logo assets are established product commitments. Do not invent customer claims, pricing, benchmarks, testimonials, press coverage, or a different product identity without supplied evidence.

## Evidence boundary

Use current repository behavior and tests as evidence for daemon lifecycle, clients, approvals, sessions, project collaboration, agent delegation, extensions, and sandbox boundaries.

Use these sources before making a product claim:

- [README.md](https://github.com/Monadix-AI/monad/blob/main/README.md) for the public overview, supported platforms, capabilities, and installation
- [Product concepts](/concepts) for shared product vocabulary
- [Runtime internals](/internals/infra/runtime) for transport, local-first, and security behavior
- [Runtime security model](/internals/infra/runtime#security-model) for network, transport, credential, and containment boundaries
- [Repository architecture](/engineering/architecture) for package ownership and extension boundaries
- [Roadmap](https://github.com/Monadix-AI/monad/blob/main/ROADMAP.md) for shipped foundations, planned work, and non-goals

Do not present a proposal as shipped behavior. Distinguish source validation, implemented behavior, and deployed effect.

## Accessibility and inclusion

Web Content Accessibility Guidelines (WCAG) AA is the minimum convention. Body text needs a contrast ratio of at least 4.5:1, and large text needs at least 3:1. Motion must honor `prefers-reduced-motion`.

Operational surfaces require keyboard access, visible focus, predictable controls, and accessible names. Product copy must explain risk and consequence without relying on color or animation.
