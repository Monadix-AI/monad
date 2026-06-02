---
title: "Grow a Mesh from One Agent to a Team"
sidebarTitle: "Build a Team"
description: "Adopt Monad Mesh progressively, from one supervised Agent to a durable multi-Agent project."
keywords: ["Monad Mesh", "multi-agent team", "progressive autonomy", "Monad project", "agent collaboration"]
---
Every Monad setup is already a mesh — Monad Mesh is the agent team runtime, and a single agent is a mesh with one member. Growing a team is adding members and structure to that same runtime, never migrating to a different one.

Start with the smallest mesh that produces useful work. Add team structure only when the work creates a real coordination need.

## Stage 1: one supervised Agent

Create a session with the default member, backed by Monad Agent Runtime. Keep approvals narrow, inspect tool calls, and establish which model, skills, tools, and sandbox roots are appropriate. The goal is a reliable single-worker loop, not maximum autonomy.

## Stage 2: durable work inside a project

Create a project when sessions should share a workspace root and a stable collaboration environment. A project holds configuration and member identity; each conversation remains its own durable project session.

Use separate sessions for independent work threads. Branch a session to explore an alternative with inherited history, and restore only when you intentionally want to rewrite the original thread.

## Stage 3: add a specialized member

Add a second member when a distinct capability, agent runtime, or responsibility exists. A member may be backed by the first-party runtime or by a third-party agent, ACP agent, or peer daemon — see [choose a runtime](/guides/choosing-runtime). Give it a clear role and bounded capability set. Avoid adding several interchangeable Agents: extra participants without distinct ownership increase routing and review cost.

## Stage 4: delegate and observe

Delegate bounded work with explicit expected outputs. Keep decisions, blockers, approvals, and artifacts attached to the project session. Observation should answer who is working, what changed, what is blocked, and what needs a human decision.

## Stage 5: increase autonomy deliberately

Expand approval scope only after repeated evidence shows that the capability, sandbox, and output review are safe. Preserve an interrupt path, bounded budgets, durable audit history, and recovery behavior at every stage.

The result is still one mesh. A one-Agent setup and a multi-Agent project differ in roster and coordination, not in their source of truth.

