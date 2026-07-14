# Setting up model providers

How to connect monad to a model provider: pick a provider, add a credential, choose a
default model. This is the user-facing companion to
[model-providers.md](../internals/model-providers.md), which explains the provider
catalog, the two provider strategies, and why the long tail of OpenAI-compatible
providers needs no extra packages.

## What you need

- A provider account and an API key (a few providers, like a local Ollama server, work
  without one).
- For self-hosted or account-scoped providers (Azure OpenAI, Ollama, and similar), the
  base URL of your endpoint.

The full list of built-in providers comes from the provider catalog — see
[the internals doc](../internals/model-providers.md) for how it is defined. Every setup
surface below reads the same catalog from the daemon, so they always offer the same
providers.

## Three ways to set up

### 1. First-run wizard (recommended)

Run `monad` (or `monad up`). It starts the daemon and opens the web UI; on a fresh
install the UI takes you through initialization, including a provider step: choose a
provider, enter the API key (and base URL where required), and pick a default model.

Prefer staying in the terminal? Run:

```sh
monad init
```

The interactive wizard walks the same path: it lists the provider catalog, prompts for
the base URL when the provider needs one, prompts for any provider-specific fields
(for example the AWS region for Amazon Bedrock), asks for the API key, tests the
connection before saving anything, and then lets you pick a default model from the
provider's model list. If the test fails you can retry with a different key or go back
and pick another provider.

`monad init --no-input` (or `-y`) seeds the home directory without prompting, for
scripted setups.

### 2. Web UI

Open **Studio → Models and providers** (`/studio/models` in the web UI). From there you
can add providers with the **Add provider** flow, manage each provider's credentials,
browse its models, and edit model profiles.

### 3. CLI

The CLI splits the surface into three nouns: `provider`, `credential`, and `model`.
All of them accept the global `--json` flag for machine-readable output.

Add or update a provider (the JSON shape is `id`, `label`, `type`, optional `baseUrl`
and `extra`):

```sh
monad provider list
monad provider set '{"id":"openrouter-1","label":"OpenRouter","type":"openrouter"}'
monad provider models openrouter-1     # list the provider's available models
monad provider remove openrouter-1
```

Attach a credential to a provider:

```sh
monad credential add openrouter-1 '{"label":"my key","authType":"api_key","accessToken":"sk-or-..."}'
monad credential list openrouter-1
monad credential test openrouter-1 <credId>    # optionally append a modelId to probe
monad credential remove openrouter-1 <credId>
```

Probe a provider and key without saving either:

```sh
monad model test '{"provider":{"id":"p1","label":"OpenRouter","type":"openrouter"},"accessToken":"sk-or-..."}'
```

On success the daemon returns the provider's model catalog, so this doubles as a model
discovery command.

## Model profiles and the default model

A model profile is a named recipe that maps roles to concrete models: `chat` is the
required default route, and optional routes cover `fast`, `vision`, `image`, `video`,
`speech`, `transcription`, `embedding`, and `memory`. A profile can also carry
generation params and fallback targets. The fixed `default` profile is used whenever a
request does not name one.

```sh
monad model list          # list profiles (the default is starred); alias: monad models
monad model use           # show the default profile
monad model use <alias>   # set the default profile
monad model set '<profile json>'
monad model rm <alias>
```

The web UI edits the same profiles under **Studio → Models and providers**.

## Where things are stored

- Providers and profiles live in `config.json` under monad's home directory.
- Secrets never live in `config.json`: credentials are stored per provider in
  `auth.json`, which is written with owner-only permissions (see
  [runtime.md](../internals/runtime.md)).
- Secrets never come back out either. `monad credential list` shows only a masked
  token preview, and `monad credential add` echoes just the new credential id.

## Provider-specific notes

- **Azure OpenAI** requires a base URL for your resource
  (`https://{resource}.openai.azure.com/openai/v1`), and the model id is your Azure
  *deployment* name.
- **Amazon Bedrock** requires an AWS region (prompted as an extra field) and a bearer
  API key (`ABSK…`).
- Neither Azure nor Bedrock exposes a standard model-listing route, so when the
  connection test returns no models, the wizard falls back to manual model-id entry —
  type the model or deployment id yourself.
- **Ollama** and similar local servers treat the API key as optional; just point the
  base URL at your server.

Details and rationale for all of the above are in
[the internals doc](../internals/model-providers.md).

## Custom providers

A provider that is not in the catalog can still be added as a third-party atom pack:
drop a module that exports a `ModelProvider` into `~/.monad/providers/` and the daemon
picks it up without a restart. See
[model-providers.md](../internals/model-providers.md) for the contract.

## For contributors

When developing monad itself, copy `.env.example` to `.env.local` and set
`OPENROUTER_API_KEY`; the dev environment seeds it as a working credential so live
runs work out of the box. This is a dev-only path — release builds configure
providers only through the flows above. See
[CONTRIBUTING.md](../../CONTRIBUTING.md).
