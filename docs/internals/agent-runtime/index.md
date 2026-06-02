---
title: "Monad Agent Runtime"
description: "Understand Monad's first-party agent runtime: turn input, model calls, tools, context, memory, approvals, and sandboxed execution."
sidebarTitle: "Monad Agent Runtime Overview"
---
This category covers Monad Agent Runtime: the agent runtime Monad ships itself, and the default member of a mesh. It explains what enters a turn, how the agent calls tools, and what it remembers. [Monad Mesh](/internals/agent-team-runtime/index) owns the session, team membership, policy, and durable collaboration state around that turn.

This runtime is one member among several and is optional. Third-party agent providers, Agent Client Protocol agents, and peer daemons join the same mesh through adapters and do not execute through it.

```mermaid
flowchart TB
  subgraph Turn["One turn"]
    Assemble["Assemble context"]
    Call["Call model"]
    Tool{"Tool call?"}
    Gate["Approval gate"]
    Exec["Execute in sandbox"]
    Done["Persist + emit terminal event"]
  end

  subgraph Inputs["Context inputs"]
    Sys["System prompt · persona · operating rules"]
    Hist["Transcript (possibly compacted)"]
    Skills["Skill metadata (L1) + loaded bodies (L2)"]
    Mem["Memory: facts · graph · laws"]
    Tools["Tool catalog"]
  end

  Inputs --> Assemble --> Call --> Tool
  Tool -- no --> Done
  Tool -- yes --> Gate --> Exec --> Call
```

## Context pressure is a cascade, not a cliff

Cheap and lossless first; lossy only when it must be. Every stage is observable or
recoverable. The runtime never truncates this state silently.

```mermaid
flowchart LR
  A["Eviction<br/>tool output → placeholder<br/>(recoverable by handle)"] --> B["Durable summarization<br/>older turns → persisted briefing"]
  B --> C["Recitation<br/>re-anchor the plan after compaction"]
  C --> D["Retrieval<br/>pull back only what this turn needs"]
  D --> E["Hard token limiter<br/>last-resort backstop"]
```

Details and the `context.*` config block: [context-management.md](/internals/agent-runtime/context-management).

## Memory is layered by cost and durability

```mermaid
flowchart TB
  L0["Static core<br/>USER.md · SOUL.md · AGENT.md<br/>always injected, human-curated"]
  L1["L1 facts<br/>Markdown under ~/.monad/memory, scoped global / agent / session"]
  L2["L2 knowledge graph<br/>entities + relations extracted by consolidation"]
  L3["L3 laws<br/>general rules inferred from facts, injected as recall prefix"]
  L0 --> Prompt["System prompt"]
  L1 --> Prompt
  L3 --> Prompt
  L2 -.-> Recall["On-demand recall"] --> Prompt
```

`/consolidate` runs the dedup/merge/extract pipeline; `/why` traces a belief back to the
messages that produced it. Details: [memory.md](/internals/agent-runtime/memory).

## Every tool call passes one seam

```mermaid
flowchart LR
  Model["Model emits tool call"] --> Invoke["invokeTool()"]
  Invoke --> Parse["Parse inputSchema<br/>reject on ToolInputError"]
  Parse --> Risk{"highRisk<br/>or scoped?"}
  Risk -- yes --> Gate["Oversight gate<br/>fail-closed: no gate = denied"]
  Risk -- no --> Guards
  Gate -- approved --> Guards["Call-time guards<br/>path roots · SSRF · size/time caps"]
  Gate -- denied --> Deny["Return denial to the model"]
  Guards --> Run["tool.run() in sandbox"]
```

Never call `tool.run()` directly. The gate and sandbox context are applied by
`invokeTool` only. Details: [tools.md](/internals/agent-runtime/tools).

## Documents

| Doc | Covers |
|---|---|
| [tools.md](/internals/agent-runtime/tools) | Registry layout, uniform module contract, authoring and security rules |
| [context-management.md](/internals/agent-runtime/context-management) | The gentle cascade, eviction handles, summarization, observability |
| [memory.md](/internals/agent-runtime/memory) | L1/L2/L3 layers, consolidation pipeline, provenance, contradiction checks |
| [operation-source.md](/internals/agent-runtime/operation-source) | Immutable provenance, server stamping, and the temporary transport-authority exception |

Related pages cover the [user-facing session model](/usage/sessions) and [skill authoring](/usage/skills). Repository contributors must also follow the [security rules](https://github.com/Monadix-AI/monad/blob/main/docs/internal/development/security-guidelines.md) for Agent tool code.
