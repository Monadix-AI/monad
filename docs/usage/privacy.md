---
title: "Data and Network"
sidebarTitle: "Data and Network"
description: "Understand what Monad stores locally, which configured actions use the network, and how data is deleted."
keywords: ["Monad privacy", "local-first", "telemetry", "data storage", "network access"]
---
What Monad stores, and what leaves your machine. Every claim here is a statement about the
current code — if you find a discrepancy, that is a bug worth reporting.

## The short version

- **Monad sends no telemetry, analytics, crash reports, or usage pings. Ever. There is no
  opt-out because there is nothing to opt out of.**
- **No account is required.** Monad has no sign-up, no license check, and no server of its
  own that it phones home to.
- All state — sessions, transcripts, memory, credentials, settings — lives on your disk
  under `~/.monad`.
- The daemon binds **loopback only** by default. A bound loopback port is not an exposed
  port.
- The traffic that *does* leave your machine is traffic you asked for: your model
  provider, and whatever tools you enable.

## What leaves the machine, and when

Nothing in this table happens until you configure or invoke it.

| Destination | Triggered by | Carries |
|---|---|---|
| Your model provider's API | Every agent turn | The prompt: system prompt, transcript, injected memory and skill text, tool results |
| `models.dev` | Model settings, pricing and tier resolution | Nothing about you — it fetches a public catalog |
| `api.github.com`, `registry.npmjs.org` | `monad atom install`, `monad skill install`, MCP binary install | The package coordinates you asked for |
| Glama / Smithery / the MCP registry | `monad mcp search` | Your search query |
| GitHub Releases | `monad upgrade` (and only then) | Nothing but the release request |
| Qdrant's GitHub release | First use of the optional `mem0` memory backend | Nothing — a binary download |
| MCP servers you configure | Their tool calls | Whatever the tool call contains |
| Channels you configure | Inbound and outbound messages | The conversation on that platform |
| Peers / Monadix, if configured | Delegated subtasks | The instruction you delegate |

There is **no background update check**. `monad upgrade` contacts GitHub only when you run
it.

The model provider is the significant one: an agent turn sends the model whatever is in
its context window. If a file's contents were read by a tool, they are in the transcript,
and the transcript goes to the provider on the next turn. Choose your provider
accordingly — that is a property of using a hosted model, not of Monad.

## Observability is off by default

Monad is instrumented with OpenTelemetry, but the exporter has **no default endpoint**:

```jsonc
// config.json
"observability": { "endpoint": "" }   // empty = disabled, the default
```

Set it to an OTLP endpoint and traces and metrics are exported *there* — to a collector
you run. Nothing is sent to Monad or to any third party. In development mode the endpoint
auto-defaults to `http://localhost:6006` (a local Phoenix instance) unless you set it
yourself; that is still your own machine.

## Where your data lives

```text
~/.monad/
  configs/config.json         settings
  configs/agents.json         agents, providers, and their credentials
  configs/mesh.json           mesh agents, ACP agents, peers, Monadix
  credentials/auth.json       agent runtime credentials (mode 0600)
  db/monad.sqlite             sessions, messages, events
  memory/                     durable facts, knowledge graph, laws
  atoms/                      installed packs, skills, MCP configs, locales, providers
  agents/<agentId>/           per-agent workspace
  workplace/<projectId>/      managed Workplace Project data
    shared/                   all project sessions and members
    agents/<projectMemberId>/ one member across project sessions
    sessions/<sessionId>/     all members in one session
    runtime/<sessionId>/<projectMemberId>/
                              one member-session runtime
  logs/                       daemon logs
```

On Linux these paths split across the XDG base directories. `MONAD_HOME` overrides the complete data root.

For managed agents, Monad grants the provider the four concrete shared, member,
session, and runtime directories that belong to that runtime. Monad does not grant the
containing project directory as one broad working root. Provider sandbox enforcement
still depends on the selected provider and launch mode; these boundaries do not replace
host operating-system permissions.

Files in a session workspace are collaborative and writable by every managed agent in
that session. Product rules can be narrower. For example, Kanban requires its Product
Design and Tech Design documents to be published by the assigned host from the task's
canonical session directory; that check is enforced by the Experience API rather than
by a filesystem ACL.

## Secrets

- Credentials are never returned by the API. Settings responses mask them; `monad
  credential list` shows only a preview.
- Secrets are never written to logs, transcripts, or structured CLI output, and never
  passed in argv.
- `auth.json` is written mode `0600` and sits inside a vault that the agent's own
  filesystem tools are denied — an agent cannot read its way to your keys.
- Agent Runtime Credentials go further: generated code receives a per-run sentinel, and
  the real value is substituted only on the leg to the hosts you allowed. See
  [agent-runtime-credentials.md](/usage/agent-runtime-credentials).
- Windows has no `chmod`; the daemon relies on per-user profile ACLs there. Documented
  rather than pretended-away.

## Third-party code

`monad license list` lists every third-party package in the production dependency graph with
its license. Atom packs, skills, and MCP servers you install are third-party code that
runs with the access you grant it — treat them like installed software, and read
[SECURITY.md](https://github.com/Monadix-AI/monad/blob/main/SECURITY.md) before installing something you did not write.

## Documentation site data

The claims above describe the Monad product runtime. A hosted Mintlify documentation site is a separate web service. It may process page views, searches, page feedback, or AI assistant requests only when the project owner enables the corresponding Mintlify Dashboard add-on. The documentation site does not automatically receive sessions, credentials, or configuration from your local daemon. Do not paste secrets, private transcripts, or sensitive logs into feedback.

## Deleting your data

```bash
monad purge sessions     # clear transcripts, keep configuration
monad purge all          # clear sessions, config, auth, and usage
monad purge              # wipe and rebuild ~/.monad entirely (double confirmation)
```

To remove Monad itself as well, see [Uninstalling](https://github.com/Monadix-AI/monad/blob/main/README.md#uninstall).
