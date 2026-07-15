# Agent Flow Editor Design

Date: 2026-07-14
Status: ready for implementation review
Visual target: Product Design ideation option 3, `exec-115f4436-f190-4969-baa5-982e52fb1f66.png`

## Goal

Replace the current Agent Workshop assembly metaphor with a causal, plain-language flow that helps a non-expert understand how an agent turns a request into a response. The editor must keep every existing agent setting and save contract while making the common path obvious and moving technical controls behind progressive disclosure.

Success means a first-time user can answer three questions without documentation:

1. What happens when this agent receives a request?
2. Which part of the flow changes each setting?
3. Which settings are inherited, configured, or still worth reviewing?

## Scope

The change is limited to the built-in Monad Agent editor under Studio / Agents. It replaces the visual structure inside `AgentWorkshop` and its workshop-specific child components. It does not change daemon APIs, protocol types, persistence, agent execution order, the Agents list, third-party agents, or the global Models, Capabilities, Memory, and Safety settings pages.

The existing `AgentEditor` state and `buildAgentEditorUpdate` mapping remain the source of truth. Saving continues to use `useUpdateAgentMutation` and `useSetAgentPromptMutation`.

## Experience Model

The main surface is a React Flow canvas with six fixed, connected nodes:

1. User request
2. Identity and instructions
3. Model
4. Tools and knowledge
5. Safety check
6. Response

The sequence is explanatory, not a new runtime graph. Nodes cannot be deleted, connected, duplicated, or reordered. Users may pan and zoom, select a node, fit the flow to view, and reset the viewport. Edges are non-interactive and communicate cause and effect.

Selecting an editable node opens one anchored detail panel on the right. The selected node and its panel share an accent color and a dotted visual connector. Only one panel is open at a time. Clicking the canvas closes the panel; Escape closes it and returns focus to the selected node.

The initial selection is Identity and instructions because it contains the agent name, delegation description, and system prompt: the highest-value beginner configuration. The canvas remembers no layout changes because node positions are product-defined.

## Node Mapping

### User request

This is a read-only teaching node. It explains what enters the agent and displays a realistic example request. The supporting `Try with a sample request` action opens a local preview dialog; it does not create a session, call a model, or persist data in this implementation.

### Identity and instructions

Default fields:

- Name -> `name`
- When should this agent be used? -> `description`
- Instructions -> `prompt`

The panel includes optional suggestion chips that append short, editable guidance to the prompt. Suggestions are local editing helpers and do not create a new persisted schema. Advanced reveals the raw prompt editor and any prompt-specific technical help.

### Model

Default field:

- Model -> `model`

An empty value is presented as `Use workspace default`. Advanced reveals role overrides from `roles`, using the existing model profiles and role labels.

### Tools and knowledge

Default fields:

- Access mode -> `atomsMode`
- Selected capabilities -> `atomsAllow`

`inherit` is described as `Use workspace capabilities`. `allowlist` is described as `Choose capabilities for this agent`. The searchable catalog combines enabled Atom Packs and MCP servers exactly as the current editor does. Advanced exposes source kind and technical identifiers.

### Safety check

Default field:

- Sandbox -> `sandboxMode`

Empty sandbox mode is presented as inherited. Advanced reveals `maxTurns`, `maxThinkingTokens`, and `maxBudgetUsd`. Blank limits continue to mean inherited or unlimited according to the current backend contract; the UI must not invent defaults.

### Response

This is a read-only summary node. It derives a short preview from the current prompt, model inheritance state, and selected capabilities. It never claims to be an actual model response. The label is `Preview of configured behavior` and the empty state explains that the preview updates as instructions are added.

### Availability

The visual target folds availability into the overall flow, but existing settings must remain accessible. A compact `Who can use this agent?` section sits beneath the Response node panel or in the Response advanced disclosure:

- Other Monad agents -> `subagentCallable`
- Published to Monadix -> `isPublic`; this also exposes the agent through the local OpenAI-compatible API
- Use Monadix -> `monadixConsume`
- A2A -> `a2aEnabled`, with current `a2aStatus`

This placement keeps the six-node causal story intact while preserving every existing field. Exposure warnings remain visible in the header when any availability setting is enabled.

## Readiness Language

The header uses a compact summary such as `Ready to use · 2 optional improvements`. Readiness is advisory and never blocks Save.

- Ready to use: name is non-empty and the current backend-required fields are valid.
- Optional improvements count: empty prompt, inherited model, inherited tool access, inherited sandbox, or standalone-only availability.
- Needs attention: an invalid numeric limit or a required name is empty.

The UI must not describe inherited settings as incomplete or unsafe. Inheritance is a valid configuration and should read as a calm, neutral state.

## Layout and Responsive Behavior

At desktop widths of 1180px and above, the canvas fills the editor and the detail panel occupies approximately 420px on the right. The flow is vertically centered in the remaining canvas, with nodes approximately 380px wide and 104-128px tall. The target viewport is 1440 x 1024 and preserves the existing Studio sidebar and breadcrumb header.

Between 768px and 1179px, the detail panel becomes a right-side overlay over the canvas. Below 768px, React Flow remains the overview but selecting a node opens a bottom sheet. The canvas uses a minimum usable height rather than forcing horizontal page scroll. Controls stay reachable by keyboard and touch.

Visual styling reuses Monad tokens and components: background, foreground, muted, border, primary, warning, Button, Input, Label, Switch, Select, ScrollArea, and Hugeicons. The only external visual dependency is the already-installed `@xyflow/react`. There are no new raster assets, custom illustrations, gradients, inline SVGs, or bespoke icon drawings.

## Component Boundaries

- `AgentWorkshop`: owns selected node, panel open state, derived readiness, capability catalog, and React Flow composition.
- `AgentFlowCanvas`: owns fixed node/edge definitions, viewport controls, selection events, keyboard behavior, and responsive fit-to-view behavior.
- `AgentFlowNode`: renders the shared node shell and plain-language status summary.
- `AgentFlowPanel`: routes the selected node to one focused editor section.
- `IdentityInstructionsPanel`, `ModelPanel`, `ToolsKnowledgePanel`, `SafetyPanel`, and `AvailabilityPanel`: edit existing `AgentEditor` state through callbacks only.
- `agent-flow-model.ts`: pure derivation functions for node summaries, optional-improvement count, prompt suggestion insertion, and numeric validation.

Pure model functions are kept outside React so wording-independent behavior can be unit tested without rendering the canvas.

## State and Data Flow

`AgentEditor` remains the state owner. It fetches the agent, prompt, and A2A status; passes values and setters into `AgentWorkshop`; and saves through the existing mutations. `AgentWorkshop` derives view-only node data with `useMemo`. A panel edit calls the existing setter immediately, which updates both the panel and node summary. Save uses the existing header action and sends the same payload shape as today.

No React Flow node position is persisted. No new server state, endpoint, query parameter, local storage key, or schema field is introduced.

## Error Handling

- Save errors use the app's existing mutation error/toast behavior; the editor keeps unsaved local state.
- Invalid numeric limits are shown inline in the Safety panel and disable Save until corrected.
- Capability queries may load independently. The Tools node shows a local loading state and preserves current selections while the catalog loads.
- If an existing selected capability is no longer present in the catalog, it remains visible as unavailable and can be removed; it is never silently dropped.
- If model profiles are unavailable, the inherited/default choice remains usable and role overrides show an empty-state explanation.
- The sample-request preview is local-only and cannot fail due to network or model configuration.

## Accessibility

- Every node is a button-like selectable element with a unique accessible name and selected state.
- The logical tab order follows the six-node sequence, independent of React Flow DOM placement.
- Arrow keys move between adjacent nodes; Enter or Space opens the panel; Escape closes it.
- Selection is conveyed by border, icon treatment, and `aria-selected`, not color alone.
- Status text is always explicit: inherited, configured, optional, or needs attention.
- Panel titles are headings and fields retain visible labels and descriptions.
- Reduced-motion mode removes animated edge emphasis and panel transitions.

## Testing and Verification

Unit tests cover:

- each state-to-node summary mapping;
- readiness and optional-improvement derivation;
- inherited settings being treated as valid;
- numeric validation;
- prompt suggestion insertion without duplicate text;
- preservation of unavailable selected capabilities.

Component tests cover node selection, panel routing, Escape behavior, setter calls, Advanced disclosure, and Save-disabled behavior for invalid values.

Browser verification covers the 1440 x 1024 selected state shown in the visual target, keyboard navigation, panel editing, canvas controls, a narrow overlay state, and Save against the local daemon. Design QA compares the selected mockup and implementation at the same viewport and selected node state; P0-P2 differences are fixed before handoff.

## Acceptance Criteria

- The page visibly matches option 3's top-to-bottom causal flow and anchored editing panel.
- A non-expert can edit name, description, prompt, model, tool access, safety, budgets, and availability without encountering workshop jargon.
- All current agent fields remain editable and save through the existing contracts.
- React Flow provides the canvas, viewport, selection, and edge rendering.
- Nodes are fixed product concepts, not user-authored workflow objects.
- Inherited settings are presented as valid defaults.
- Core interactions work with pointer and keyboard.
- Unit, component, typecheck, browser, and design QA checks pass for the changed scope.
