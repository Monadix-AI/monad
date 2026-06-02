# Product

## Register

product

## Users

Three overlapping groups who all share the same UI surface:

1. **Everyday AI agent users** — non-technical or semi-technical people who want a capable local AI agent experience similar to Claude Code / Codex. They care about the chat flow being smooth and approachable. Settings complexity should stay out of their way.
2. **Developer power users** — engineers who run agentic sessions, configure model providers, wire up MCP servers, install atom packs, and read tool-approval events. Information density matters; they trust the tool with real work.
3. **Team operators** — people who set up monad for others, manage approval rules, configure channels (Telegram, etc.), and monitor sessions. Onboarding, policy UI, and observability are their primary surfaces.

Context: always local, often running alongside code or a terminal. The browser window lives next to other work.

## Product Purpose

monad runs as a local daemon that serves agentic AI sessions — with a REST + SSE API, CLI, and this web UI. It keeps all state local (nothing goes to a cloud service), binds loopback only by default, and is designed to be a power tool that non-experts can still use.

Success looks like: any user, regardless of technical background, can start a session, understand what the agent is doing, and trust the output — while power users can configure every dial without leaving the browser.

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
- **Aggressive dark brand-first UIs** (red hero stripes, pure near-black everywhere, no warmth) — the current DESIGN.md marketing aesthetic is right for a launch page, wrong for a product UI people live in.

## Design Principles

1. **Warm precision** — the UI should feel warm and inviting (generous whitespace, soft surfaces, considered color) without sacrificing information density and keyboard-first efficiency. Warmth is achieved through quality and care, not decorative friendliness.
2. **Progressive depth** — the first thing you see on any screen should be learnable by a non-technical user. The full depth (model config, MCP wiring, approval policies, atom conflicts) should be there and reachable, but it shouldn't crowd the primary experience.
3. **Agency, clearly surfaced** — when the agent takes an action or asks for approval, the UI makes it impossible to miss and easy to understand. Trust is built by clarity about what's happening and why.
4. **One surface, two speeds** — the same UI serves a casual afternoon session and a 6-hour deep-work agentic coding run. Design for both cadences: smooth and frictionless at low stakes, dense and precise when things get serious.
5. **Earned craft** — every detail should feel intentional, not decorated. No gradients for gradient's sake, no animation for animation's sake. The interface earns the user's trust through consistency, contrast, and precision.

## Accessibility & Inclusion

WCAG AA minimum by convention (4.5:1 body text, 3:1 large/bold). Motion handled with `prefers-reduced-motion` support throughout — the init wizard already sets the standard. No formally scoped requirements beyond that.
