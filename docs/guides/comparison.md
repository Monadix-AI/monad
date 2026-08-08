---
title: "Why Monad"
sidebarTitle: "Why Monad"
description: "Understand what Monad owns that a chat client, a provider CLI, or a coordination layer does not: agents live inside the runtime."
keywords: ["agent runtime", "daemon-first", "durable sessions", "agent teams", "governed autonomy"]
---
Most tools in this space **coordinate agents that live somewhere else**. The agent's
identity, memory, permissions, and history belong to whatever product actually runs it —
a vendor CLI, a hosted service, a chat client — and the coordination layer coaches those
processes from the outside. When the outer tool goes away, nothing durable is left; when
the inner product changes, the team changes with it.

**Monad is where agents live.** The local `monad` daemon owns the identity, capabilities,
permissions, memory, sessions, collaboration state, approvals, and audit history itself.
Monad Mesh — the agent team runtime — is that ownership made operational. Other runtimes
are welcome as members through third-party agent adapters, the Agent Client Protocol, and peer
federation. Hosting a team out of runtimes you did not write is only possible for a layer
that owns the state in the first place.

## What that changes

**Work outlives every client and every vendor.** A session started in the CLI continues
in the browser, in the terminal UI, in an editor, or from a chat channel. Swapping which
runtime backs a member does not create a new teammate or a new silo — the member identity,
its history, and its bindings stay put.

**One daemon, not a platform to deploy.** Monad installs as a single binary and runs as
one long-lived process bound to loopback. There is no cluster, message server, gateway, or
object store to stand up before the first agent runs; the macOS/Linux installer starts Monad for
you. It is a runtime for the machine you already work on.

**Governance sits under the agent, not beside it.** For work Monad Agent Runtime executes,
approvals gate tool calls before they run and fail closed when nobody can answer. Tool
arguments are schema-validated, filesystem paths are resolved against sandbox roots, and
outbound requests are SSRF-filtered. Child processes run under the OS's own confinement —
Seatbelt on macOS, bwrap or Landlock plus seccomp on Linux, AppContainer on Windows — with
network egress filtered through a local proxy. A member backed by a third-party runtime
executes inside that runtime's own process and permission model, so Monad governs it by
observation and by proxying its approval prompts rather than by sandboxing it. Audit is a
first-class object, not a log line, for both.

**Neutral and local by default.** No account, no license check, no telemetry, no vendor
lock: your state lives under `~/.monad`, the model provider is your choice, and the code is
MIT-licensed. The only traffic that leaves the machine is traffic you configured.

## When it is not the right tool

If you want a disposable question-and-answer exchange, a standalone chat client is
simpler. If one vendor's coding workflow covers the whole task, that vendor's CLI is
enough on its own — and when you later want it supervised, durable, and part of a team,
Monad runs it as a mesh member rather than replacing it.

Monad earns its place when work must outlive a UI, move between clients, involve more than
one agent runtime, or stay inside one policy and audit boundary.

## The short version

| Concern | Agent that lives in a client or vendor process | Monad |
|---|---|---|
| Who owns identity and memory | The product that runs the agent | The local daemon |
| Durability | Tied to that product's session | Sessions, members, artifacts, and audit persist across restarts |
| Client choice | Usually one surface, one silo | Web, CLI, TUI, editors, APIs, and chat channels drive the same state |
| Execution | One runtime | Any runtime as a mesh member: first-party, third-party, ACP, or a peer daemon |
| Governance | Product-specific prompts | Approval gate, sandbox, and egress control for first-party execution; observation, proxied approvals, and audit for every member |
| Setup | Install a product, or deploy a platform | One local daemon |

For a tool-by-tool comparison with named alternatives, read
[Monad compared with other agent tools](/guides/alternatives). Short answers to common
questions are in the [FAQ](/guides/faq).

Read [build a team](/guides/from-one-agent-to-team) to grow a mesh, then
[choose a runtime](/guides/choosing-runtime) to decide which agent runtime backs each
member.
