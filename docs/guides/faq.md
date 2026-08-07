---
title: "Frequently Asked Questions"
sidebarTitle: "FAQ"
description: "Answers to common questions about Monad, the open-source daemon-first agent team runtime from Monadix: what it is, what it runs on, what leaves your machine, and which agent runtimes can join a team."
keywords: ["what is Monad", "agent team runtime", "daemon-first", "local AI agents", "Monad FAQ", "agent runtime security", "Monadix"]
---
Short answers to the questions people ask most about Monad. Each answer stands on its own;
follow the links for the full treatment.

## What is Monad?

Monad is an open-source agent team runtime from Monadix. One long-lived local daemon owns
the identity, capabilities, permissions, memory, sessions, collaboration state, approvals,
and audit history of your agents, and keeps them when clients close, when the daemon
restarts, and when you swap the runtime backing a team member. It installs as one binary and
runs as one process on the machine you already use. See [concepts](/concepts).

## What does daemon-first mean?

Daemon-first means the durable state lives in a background process rather than in an
application window. The Web UI, CLI, TUI, editor bridges, APIs, and messaging channels are
clients that render and control that state; none of them owns it, and closing one does not
end the work. See [runtime, configuration, and security](/internals/infra/runtime).

## How is Monad different from an agent framework such as LangGraph or CrewAI?

A framework is a library inside your process that expresses agent logic. Monad is a process
that outlives your script: it owns credentials, gates tool calls behind human approval,
confines child processes in an OS sandbox, and keeps an audit trail. Framework-built agents
can join a Monad team over the Agent Client Protocol. See
[the full comparison](/guides/alternatives).

## Can Claude Code, Codex, or Gemini CLI join a Monad team?

Yes. A team member can be backed by a third-party agent provider such as Codex, Claude Code,
Gemini CLI, or Qwen Code, by an agent reached over the Agent Client Protocol, by a peer
daemon you own, or by Monad Agent Runtime, the first-party runtime Monad bundles. A member
backed by a third-party runtime keeps that runtime's own execution and permission model;
Monad records its activity and proxies its approval prompts where the provider exposes them.
See [use third-party agents](/usage/mesh-agents).

## Does Monad send my code or data to the cloud?

Monad sends no telemetry, analytics, crash reports, or usage pings, and stores its state on
your machine. Requests to the model providers you configure still leave the machine, because
that is where inference happens. Read [privacy](/usage/privacy) for exactly what is stored
and what crosses the network.

## What operating systems does Monad run on?

macOS, Linux, and Windows. The daemon, CLI, and Web UI target all three, and continuous
integration runs the full suite on each. See [installation](/usage/installation).

## Do I need Kubernetes, a message broker, or a database server?

No. Monad is a runtime, not a platform you deploy. It is a single binary and one process on
your own machine, with no cluster, message server, gateway, or object store.

## Is Monad free and open source?

Yes. Monad is released under the MIT license by Monadix Labs, Inc. The source is at
[github.com/Monadix-AI/monad](https://github.com/Monadix-AI/monad).

## How does Monad keep an agent from damaging my machine?

Under Monad Agent Runtime, tool calls are gated by an approval gate, child processes are
confined by an OS-level sandbox (Seatbelt on macOS, Landlock and seccomp or bwrap on Linux,
AppContainer on Windows), network egress is filtered, and every decision is recorded. See
[sandbox backends](/usage/sandbox-backends) and the
[runtime security model](/internals/infra/runtime#security-model).

## Which model providers does Monad support?

Monad ships 24 built-in provider types. Eight use a dedicated SDK — Anthropic, OpenAI,
OpenRouter, Vercel AI Gateway, Google Gemini, Mistral, Amazon Bedrock, and Azure OpenAI —
and 16 are presets over the bundled OpenAI-compatible adapter, covering Groq, xAI, DeepSeek,
Together, Fireworks, Cerebras, Perplexity, Moonshot, Z.AI, MiniMax, NVIDIA, Novita, Ollama,
Hugging Face, Cloudflare AI Gateway, and any other OpenAI-compatible endpoint. Custom
providers are added as Atom Packs without patching the daemon. See
[model providers](/usage/model-providers).

## Can Monad talk to Model Context Protocol servers?

Yes. MCP servers are one of the ways a Monad agent gains capability, alongside skills, Atom
Packs, hooks, channels, and agent adapters. See [MCP](/usage/mcp).

## Can I reach my agents from a phone or a chat app?

Yes. Monad ships 17 channel adapters — including Telegram, Discord, Slack, WhatsApp, Signal,
IRC, Microsoft Teams, Google Chat, Feishu, WeCom, LINE, iMessage, email, and a generic
webhook — so a session can be driven from a chat conversation and continued in the browser,
the CLI, or the terminal UI. See [channels](/usage/channels).

## Can I reach the daemon from another machine?

Only if you turn it on. Monad binds local interfaces by default. Remote access is explicit
opt-in, requires a bearer token for every non-loopback request, and should sit behind TLS —
a reverse proxy, SSH tunnel, or VPN. See [remote access](/guides/remote-access).

## When should I not use Monad?

Monad is the wrong tool in four cases. It is not a hosting platform: if you are shipping an
agent-powered product to your customers, you want a serving platform with autoscaling and
multi-tenancy, not a single-machine daemon. It is not an authoring framework: if what you
need is a way to express agent logic as a graph inside your own application, use a framework
and, if it helps later, attach it to Monad over ACP. It does not do cross-owner
collaboration: peer federation delegates between daemons **you** own, and work spanning
different owners with independent trust and billing belongs to Monadix. And it does not
schedule work across a fleet — there is no distributed scheduler and no universal task
schema, so a cluster-scale workload is out of scope.

Two more limits worth knowing before you commit. Monad Mesh is alpha and Monad Agent Runtime
is experimental, so the API can change between releases. And `net: 'filtered'` egress control
is enforced at the application layer on every platform: a child process that opens a raw
socket bypasses the domain allowlist everywhere except macOS. See
[sandbox backends](/usage/sandbox-backends) for what each platform actually enforces.

## Is Monad ready for production?

Monad Mesh, the agent team runtime, is in alpha: team ownership, session bindings, policy,
observation, and collaboration state work and are usable. Monad Agent Runtime is
experimental — the core works, but the Web experience and detail features are still being
completed and the API can change between releases. See the roadmap in the
[README](https://github.com/Monadix-AI/monad#roadmap).

## Is this Monad related to the Monad blockchain or the monad in functional programming?

No. Monad here is an agent team runtime published by Monadix Labs, Inc. under the MIT
license. It is unrelated to the Monad layer-1 blockchain and to the monad of category theory
and functional programming.

## What is Monadix?

Monadix Labs, Inc. publishes Monad and operates Monadix, the collaboration network for
cross-owner agent work. Peer federation inside Monad delegates work between daemons owned by
the same operator; collaboration across different owners, with independent trust and
billing, belongs to Monadix.

## Related

- [Get started](/getting-started)
- [Why Monad](/guides/comparison)
- [Monad compared with other agent tools](/guides/alternatives)
- [Troubleshooting](/usage/troubleshooting)
