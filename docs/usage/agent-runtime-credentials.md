---
title: "Agent Runtime Credentials"
description: "Agent Runtime Credentials let generated agent code use a secret without placing the secret value in the model context. They are only for Code Act, shell."
sidebarTitle: "Credentials"
keywords: ["agent credentials", "secret management", "Code Act", "protected execution", "API key handling"]
---
Agent Runtime Credentials let generated agent code use a secret without placing the
secret value in the model context. They are only for Code Act, shell scripts, and
processes launched by an agent.

Monad-native features do not use this registry. Model providers, channels, MCP
servers, peers, Monadix, atom registries, and native agent adapters store their
credentials directly beside the settings that own them. Those files are sensitive;
the user is responsible for their filesystem security.

## Configure and grant a credential

1. Open **Studio → Monad Agent Runtime → Credentials**.
2. Create a credential with a label, an environment-variable name, the secret, and
   one or more exact DNS hostnames. Schemes, ports, paths, IP addresses, and
   wildcards are rejected.
3. Open **Studio → Monad Agent Runtime → Agents**, edit an agent, and grant the credential
   from its Sandbox settings.
4. In generated Code Act or shell code, use the ordinary environment variable:

   ```sh
   curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user
   ```

The prompt contains only the credential's label, description, environment-variable
name, and allowed hosts. It never contains the secret.

## Protected execution

For credentialed execution, Monad:

- injects a per-run sentinel instead of the secret;
- starts a protected local proxy;
- substitutes the real value only for exact configured hosts;
- redacts the secret from bidirectional traffic and tool results;
- prevents agent tools from reading `auth.json` or the credential directory; and
- fails before process launch when the required sandbox, TLS, or proxy containment is
  unavailable.

Deleting a credential also removes its grants from affected agents. Editing a saved
credential never returns its current secret to a client: keep it, replace it, or
remove it explicitly.

## Storage boundary

`auth.json` version 1 contains only Agent Runtime Credentials. It is owner-only and is
inside the credential vault denied to agent filesystem tools. Agent records store
only credential IDs.

Native credentials are deliberately outside this mechanism:

| Owner | Storage |
|---|---|
| Model providers and MCP servers | `agents.json`, beside the provider or server |
| Channels and atom registries | `config.json`, beside the owning setting |
| Peers, Monadix, ACP, and managed native agents | `mesh.json`, beside the owning setting |

Native credential settings use their direct value. `${secret:...}` references are no
longer supported.

## Breaking migration from legacy auth.json

There is no compatibility reader or automatic migration. An `auth.json` using the
legacy credential-pool shape causes startup validation to fail so secrets cannot be
silently reinterpreted.

For a development home:

1. Stop its daemon and back up the complete config directory.
2. Re-enter provider, channel, MCP, peer, Monadix, registry, and native-agent
   credentials in their owning Studio or CLI settings. Do not copy
   `${secret:...}` references.
3. Replace `auth.json` with the current version 1 shape below, or let a fresh Monad home
   create it:

   ```json
   {
     "version": 1,
     "updatedAt": "2026-07-29T00:00:00.000Z",
     "credentials": {}
   }
   ```

4. Create Agent Runtime Credentials in Studio and grant them to agents explicitly.
5. Start the daemon and verify provider connectivity and any native integrations.

Do not copy a legacy native secret pool into the current `credentials` object. Doing so would
incorrectly expose native authentication as an agent-execution capability.

Repository contributors can use the [development migration reference](https://github.com/Monadix-AI/monad/blob/main/docs/internal/development/agent-credentials-dev-migration.md) for provider, agent, channel, and peer examples.
