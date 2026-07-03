# Studio IA and UX redesign

## Status

Approved direction: use the Studio wireframe v1 direction from the visual companion session.

Primary goal: make ownership boundaries obvious. Studio must clearly separate Monad-owned runtime configuration from provider-owned swarm participation, while keeping common setup and operations efficient.

## Problem

Studio currently mixes several classification models:

- `Agents`, `Capabilities`, `Runtime`, and `Usage` are separate sidebar groups.
- ACP agents and Native CLI agents are both presented through `thirdPartyAgents`, even though they have different ownership models.
- Several pages are settings panels with local organization but no shared Studio-level page pattern.
- Workplace project member setup and Studio native CLI setup are connected by behavior, but the IA does not make that relationship obvious.

The result is that users cannot quickly answer:

- Is Monad running and governing this capability?
- Is a provider-owned native client running its own runtime?
- Is this setting global runtime setup or project swarm setup?
- Where should I start if I want to build an agent, invite a provider CLI, or configure runtime policy?

## Design principle

Use runtime ownership as the top-level IA rule.

- Agent Runtime: Monad owns model routing, agent profiles, tools, MCP, ACP delegation, memory, approvals, hooks, sandbox policy, and usage visibility.
- Agent Swarm: Monad coordinates Workplace projects and provider-owned agents. Provider CLIs own their own runtime, tools, authentication, and approval lifecycle; Monad relays content, session state, and user decisions.

Do not use "third-party agents" as a top-level product concept. It hides the important difference between ACP delegates and Native CLI agents.

## Top-level navigation

Studio should use a persistent left navigation with three visible groups.

### Agent Runtime

Default section: `Runtime overview`.

Items:

- Runtime overview
- Models and providers
- Monad agents
- Capabilities
- ACP delegates
- Memory
- Safety and hooks

Mapping from current routes:

- `/studio/models` -> Models and providers
- `/studio/agents` -> Monad agents
- `/studio/orchestration` -> Monad agents, as a local orchestration subsection or related route
- `/studio/capabilities`, `/studio/tools`, `/studio/mcpServers`, `/studio/mcpAtoms` -> Capabilities
- `/studio/skills` and `/studio/atoms` -> Capabilities, as subsections or related pages
- `/studio/thirdPartyAgents/acp` and legacy `/studio/acpAgents` -> ACP delegates
- `/studio/memory`, `/studio/graph`, `/studio/mem0` -> Memory
- `/studio/approvals`, `/studio/hooks`, `/studio/sandbox` -> Safety and hooks

### Agent Swarm

Default section: `Swarm overview`.

Items:

- Swarm overview
- Native CLI agents
- Workplace projects
- Project members
- Tasks and sessions

Mapping from current routes:

- `/studio/thirdPartyAgents/cli` and legacy `/studio/nativeCliAgents` -> Native CLI agents
- Workplace project routes remain under `/workplace/projects/:id`, but Studio should link to them from Swarm overview and project-related cards.
- Project member configuration remains project-scoped, but Studio should expose a Swarm entry that routes users to the correct project settings flow.

### Operations

Items:

- Usage
- System

Mapping from current routes:

- `/studio/usage` -> Usage
- System is a landing area for app or daemon-level settings that are not specifically agent runtime or swarm configuration. First implementation may keep only Usage visible until there is a concrete System page.

## Page model

### Overview hub pattern

Runtime overview and Swarm overview should be real work surfaces, not marketing landing pages.

Each overview uses:

- A compact title header with a one-sentence boundary description.
- Status cards for configured objects and missing setup.
- Recommended actions based on current state.
- A small relationship map showing the relevant flow.
- Explicit boundary copy for ownership-sensitive features.

Runtime overview copy:

> Configure the Monad-owned runtime: model routing, agents, tools, memory, approval policy, and ACP delegation.

Swarm overview copy:

> Coordinate provider-owned agents and Workplace projects. Monad relays content, sessions, and member state.

### Detail page pattern

All Studio detail pages should share the same structure:

- Breadcrumb or parent link.
- Compact title and description.
- Optional local subsection navigation when a page combines multiple current panels.
- Toolbar area for search, filter, add, or diagnostics.
- Main list or editor area.
- Empty, loading, and error states written for the specific task.

The detail pattern should be used for:

- Models and providers
- Monad agents
- Capabilities
- ACP delegates
- Memory
- Safety and hooks
- Native CLI agents

### Capabilities page

Capabilities should become the runtime capability hub, with local subsections:

- Built-in tools
- MCP servers
- MCP atoms
- Skills
- Atoms
- Diagnostics

This keeps the sidebar short without hiding the fact that tools, MCP, skills, and atoms all extend the Monad-owned runtime.

### Safety and hooks page

Safety and hooks should combine:

- Approvals
- Sandbox defaults
- Hooks

This page should make policy order and effect visible:

- Runtime approvals apply to Monad-owned capabilities.
- Sandbox defaults govern Monad-run tools and sessions.
- Hooks observe or gate runtime lifecycle events.
- Provider-owned Native CLI approvals are relayed under Agent Swarm and are not re-decided by Monad runtime policy.

### ACP delegates page

ACP delegates should live under Agent Runtime.

The page should say:

- ACP delegates are external agent processes registered into Monad runtime delegation.
- MCP forwarding is opt-in.
- Skills and Monad-native tools are not transparently proxied unless a future explicit bridge adds that behavior.

### Native CLI agents page

Native CLI agents should live under Agent Swarm.

The page should say:

- Native CLI agents are provider-owned runtimes.
- Monad launches or connects to them, captures session state, and relays provider-owned approvals.
- Install actions open provider-owned setup surfaces; Monad does not install third-party CLIs unless a future flow explicitly asks for that permission.

## Cross-surface behavior

Studio and Workplace should remain distinct but connected.

- Studio owns global setup for native CLI provider presets and enabled agents.
- Workplace project settings own project membership and per-project member options.
- Empty states in Workplace can link to Studio Native CLI agents for global setup.
- Studio Native CLI agents can link to Workplace projects when the next action is adding a configured provider agent to a project.

Do not move project member mutation into Studio global settings. Keep project membership project-scoped.

## Route compatibility

Existing deep links should keep working.

- `/studio/acpAgents` should route to ACP delegates.
- `/studio/nativeCliAgents` should route to Native CLI agents.
- Existing `/studio/thirdPartyAgents` should route to an intermediate compatibility page or redirect to the closest new page. It should not remain a first-class nav label.
- `/studio/graph` and `/studio/mem0` should keep opening Memory with the matching tab.
- `/studio/tools`, `/studio/mcpServers`, and `/studio/mcpAtoms` should keep opening Capabilities with the matching subsection.

## Visual and interaction direction

The approved wireframe uses:

- A dense, work-focused Studio shell.
- A stable left navigation.
- Overview hubs that summarize state and route to the right detail pages.
- Detail pages that use local subsection navigation instead of adding every sub-feature to the global sidebar.
- Minimal explanatory copy, placed where ownership or side effects matter.

Avoid:

- Marketing-style hero pages.
- Cards nested inside cards.
- Large decorative illustrations.
- Generic "third-party agent" language where ownership matters.
- Reusing one page treatment for ACP and Native CLI.

## Copy rules

Use sentence-style capitalization for new labels.

Preferred labels:

- Agent Runtime
- Runtime overview
- Models and providers
- Monad agents
- Capabilities
- ACP delegates
- Memory
- Safety and hooks
- Agent Swarm
- Swarm overview
- Native CLI agents
- Workplace projects
- Project members
- Tasks and sessions
- Usage
- System

Boundary copy should be short and exact:

- "Monad owns runtime policy here."
- "Provider-owned native CLIs manage their own tools and approvals."
- "MCP forwarding to ACP delegates is opt-in."
- "Project membership is configured per Workplace project."

## Implementation boundaries

First implementation should focus on IA shell and page framing, not rewriting every settings control.

In scope:

- New section taxonomy.
- Sidebar regrouping.
- Overview hub pages.
- Route compatibility.
- Moving visible ACP and Native CLI entry points into separate IA locations.
- Shared detail-page frame pattern where current pages are mounted.
- Focused copy and empty-state routing.
- Browser-level tests for navigation, route aliases, and key setup paths.

Out of scope for the first implementation:

- Rewriting all model/provider management controls.
- Rewriting all Skills and Atoms internals.
- Changing daemon settings schemas.
- Changing Native CLI provider runtime semantics.
- Adding new ACP tool or skill forwarding behavior.
- Moving Workplace project member state into Studio global settings.

## Testing requirements

Add or update browser-level tests for:

- Studio default route opens Runtime overview.
- Runtime navigation opens Models and providers, Capabilities, ACP delegates, Memory, and Safety and hooks.
- Swarm navigation opens Swarm overview and Native CLI agents.
- Legacy `/studio/acpAgents` opens ACP delegates.
- Legacy `/studio/nativeCliAgents` opens Native CLI agents.
- Legacy `/studio/tools`, `/studio/mcpServers`, and `/studio/mcpAtoms` open Capabilities with the intended subsection.
- Workplace empty-state or project settings links still route to the right Studio Native CLI setup page.

Add unit coverage where useful for route-path mapping.

## Acceptance criteria

- Users can identify whether a feature is Monad-owned runtime configuration or provider-owned swarm coordination from its navigation location and page description.
- ACP delegates and Native CLI agents are no longer visually grouped as the same kind of third-party agent.
- The global sidebar has fewer top-level settings entries than the current Studio sidebar.
- Overview hubs provide actionable status and next steps without becoming marketing pages.
- Existing deep links continue to resolve.
- No project-scoped member mutation is moved into global Studio settings.
- Browser-level navigation tests pass for the new IA.
