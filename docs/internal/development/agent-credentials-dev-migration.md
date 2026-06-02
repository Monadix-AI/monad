---
title: "Agent Credential Development Migration"
audience: "internal-developer"
description: "Manual migration from the legacy development credential-pool shape to the current v1 settings schemas."
---
> **Applies only to a development home using the legacy credential-pool shape.** The
> pre-release settings schemas are flattened into v1. If your `auth.json` already has a
> `credentials` object with Agent Runtime Credentials, nothing here applies.
>
> This is a manual, development-home-only migration. There is no compatibility
> reader and no automatic migration. The updated daemon rejects the legacy auth shape and
> legacy credential fields instead of guessing where a secret belongs.

Back up the complete development home before editing it. Stop every daemon that uses
that home, apply the changes together, and restart only after all four settings files
validate.

Native credentials now live directly beside the feature that owns them. The user is
responsible for the filesystem security of `config.json`, `agents.json`, and
`mesh.json`; settings APIs and Studio still redact their values.

## Before

The abbreviated legacy development home below mixes provider, channel, peer, and
agent-execution secrets in `auth.json` and points to them with `${secret:...}`:

```jsonc
// legacy auth.json
{
  "version": 1,
  "credentialPool": {
    "openrouter-main": {
      "providerId": "openrouter",
      "accessToken": "sk-or-provider"
    }
  },
  "channelCredentials": {
    "channel/telegram/token": "123456:telegram-token"
  },
  "peerCredentials": {
    "peer/work/token": "peer-token"
  },
  "namedSecrets": {
    "github-agent": "github_pat_agent"
  }
}
```

```jsonc
// legacy agents.json fragments
{
  "model": {
    "providers": [{ "id": "openrouter", "credentials": [] }]
  },
  "agents": [
    {
      "id": "agt_RESEARCH0001",
      "sandbox": {
        "credentials": [
          {
            "kind": "env",
            "name": "GITHUB_TOKEN",
            "value": "${secret:github-agent}",
            "allowedHosts": ["api.github.com"]
          }
        ]
      }
    }
  ]
}
```

```jsonc
// legacy config.json fragment
{
  "channels": [
    {
      "id": "chn_TELEGRAM001",
      "type": "telegram",
      "label": "Dev bot",
      "tokenRef": "${secret:channel/telegram/token}"
    }
  ]
}
```

```jsonc
// legacy mesh.json fragment
{
  "peers": [
    {
      "id": "peer_WORK000001",
      "label": "work",
      "baseUrl": "https://work.example/openai",
      "tokenRef": "${secret:peer/work/token}"
    }
  ]
}
```

## After

Move provider authentication into the provider record in `agents.json`. Move the
former sandbox environment credential into the current `auth.json` and grant only its ID to
the agent:

```jsonc
// agents.json v1 fragments
{
  "model": {
    "providers": [
      {
        "id": "openrouter",
        "label": "OpenRouter",
        "type": "openrouter",
        "credentials": [
          {
            "id": "openrouter-main",
            "label": "Development key",
            "authType": "api_key",
            "priority": 0,
            "source": "manual",
            "accessToken": "sk-or-provider",
            "lastStatus": "unknown",
            "lastStatusAt": null,
            "lastErrorCode": null,
            "lastErrorReason": null,
            "lastErrorMessage": null,
            "lastErrorResetAt": null,
            "requestCount": 0
          }
        ]
      }
    ]
  },
  "agents": [
    {
      "id": "agt_RESEARCH0001",
      "credentialIds": ["github-agent"]
    }
  ]
}
```

```jsonc
// auth.json v1
{
  "version": 1,
  "updatedAt": "2026-07-29T00:00:00.000Z",
  "credentials": {
    "github-agent": {
      "label": "GitHub API",
      "description": "Used by generated research scripts.",
      "environmentVariable": "GITHUB_TOKEN",
      "secret": "github_pat_agent",
      "allowedHosts": ["api.github.com"],
      "createdAt": "2026-07-29T00:00:00.000Z",
      "updatedAt": "2026-07-29T00:00:00.000Z"
    }
  }
}
```

Move channel and peer tokens to their owners. MCP tokens/OAuth state belong on the
MCP server in `agents.json`; Monadix, ACP, and managed native-agent authentication
belong in `mesh.json`; registry and sandbox-backend credentials belong in their
owner fields in `config.json`.

```jsonc
// config.json v1 fragment
{
  "channels": [
    {
      "id": "chn_TELEGRAM001",
      "type": "telegram",
      "label": "Dev bot",
      "credential": { "token": "123456:telegram-token" }
    }
  ]
}
```

```jsonc
// mesh.json v1 fragment
{
  "version": 1,
  "peers": [
    {
      "id": "peer_WORK000001",
      "label": "work",
      "baseUrl": "https://work.example/openai",
      "defaultAgent": "default",
      "credential": { "token": "peer-token" },
      "enabled": true
    }
  ]
}
```

Delete all legacy auth fields, legacy `sandbox.credentials`, file credentials, and
every `${secret:...}` value. Do not copy native secrets into `auth.json.credentials`.

## Verification

After restarting the development daemon:

1. Open Studio and verify provider, channel, MCP, peer, registry, and sandbox-backend
   settings report configured state without returning secret values.
2. Open **Monad Agent Runtime → Credentials** and verify only generated-execution
   credentials appear.
3. Open the migrated agent and verify its credential IDs hydrate as grants.
4. Run a protected execution against one allowed host and one different host. The
   child must receive only a per-execution sentinel; substitution must use the
   proxy's canonical destination, redact response traffic, destroy mappings after
   execution, and fail before launch on an unsupported backend.
