# Model providers

monad's gateway is a "gateway of gateways": every **provider** is one place a request can
be sent. The set of providers monad offers out of the box is defined once, in a single
catalog, and every layer (init wizard, CLI, Model Settings, the agent-core registry) derives
from it.

## The catalog is the source of truth

`PROVIDER_CATALOG` in [`packages/protocol/src/control.ts`](../packages/protocol/src/control.ts)
maps each `ModelProviderType` to a `ProviderCatalogEntry`:

| field | meaning |
|---|---|
| `label` | display name |
| `strategy` | `'native'` or `'openai-compatible'` — how the model is built (below) |
| `defaultBaseUrl` | preset endpoint (compatible presets target it; natives use it for `/models` enumeration) |
| `needsUrl` | the UI must collect a base URL (self-hosted / account-scoped; no usable default) |
| `keyPlaceholder` | API-key input hint, matching the provider's real key shape where known |
| `npmPackage` | the AI SDK package backing a native provider atom (informational) |
| `extraFields` | extra config fields persisted into `Provider.extra` (e.g. AWS region) |
| `keyOptional` | credential is optional (e.g. a local Ollama server) |

A compile-time `Record<ModelProviderType, …>` and unit tests (protocol `control.test.ts`,
agent-core `providers.test.ts`) assert the catalog covers exactly `KNOWN_PROVIDER_TYPES`, so the
enum and the catalog can't drift.

## The two strategies

The `strategy` field is the mechanism that decides how a provider's model is built. Both
strategies are **bundled and registered at startup** — there is no runtime download.

- **`native`** — a dedicated AI SDK package, one provider module in
  [`apps/monad/src/agent/model/providers/`](../apps/monad/src/agent/model/providers).
  Used only for providers that genuinely need their own SDK: Anthropic, OpenAI, OpenRouter
  (its own `@openrouter/ai-sdk-provider`), Vercel AI Gateway, Google Gemini, Mistral, Amazon
  Bedrock, Azure OpenAI.
- **`openai-compatible`** — the bundled `@ai-sdk/openai-compatible` adapter pointed at the
  catalog's `defaultBaseUrl`. This covers the entire long tail (Groq, xAI, DeepSeek, Together,
  Fireworks, Cerebras, Perplexity, Moonshot, Z.AI, MiniMax, NVIDIA, Novita, Ollama, Hugging
  Face) with **zero extra dependencies** — they are presets, generated from the catalog in
  `providers/index.ts`.

### Adding a provider

- OpenAI-compatible endpoint → add one `ModelProviderType` enum member + one
  `PROVIDER_CATALOG` entry (`strategy: 'openai-compatible'`, `defaultBaseUrl`). That's it — the
  registry, wizard, CLI, and settings pick it up automatically. Add a logo in
  [`apps/web/lib/provider-meta.tsx`](../apps/web/lib/provider-meta.tsx).
- Needs a distinct SDK → also add the package to `apps/monad/package.json` and a
  provider module, then register it in `providers/index.ts`.

## Auth model

22 of the 24 providers are exactly **base URL + token** and fit the credential model
(`{ accessToken, authType: 'api_key', baseUrl }`). Two natives carry extra requirements:

- **Azure OpenAI** — `needsUrl: true`; the user supplies a resource base URL
  (`https://{resource}.openai.azure.com/openai/v1`) + an api-key, and the model id is the
  Azure *deployment* name.
- **Amazon Bedrock** — requires an AWS `region` (an `extraField` stored in `Provider.extra`)
  and authenticates with a bearer **API key** (`ABSK…`). SigV4 (two-secret) is out of scope.

Bedrock and Azure have no standard bearer `/models` route, so the wizard and CLI fall back to a
**manual model-id entry** when a connection test returns no models.

## Why there's no runtime/dynamic download

A natural idea is to fetch a provider's npm package (or its prebuilt `dist`) at runtime when a
user selects it. We deliberately don't, because:

1. **`dist` is compiled, not bundled.** It still `import`s bare specifiers
   (`@ai-sdk/provider`, `@ai-sdk/provider-utils`, `zod`), so using it means recursively
   resolving the whole dependency tree at runtime — reimplementing a package manager.
2. **Shared spec version.** The AI SDK pins a `specificationVersion`; a downloaded provider must
   share the *same* `@ai-sdk/provider` copy as the host `ai` runtime or the model object is
   rejected. CDN bundles (esm.sh `?bundle`) duplicate that peer and drift.
3. **Supply chain.** Executing network-fetched code inside the key-holding daemon has no
   lockfile, integrity check, or audit.

Since the long tail is OpenAI-compatible, "installing" those providers requires no package at
all — they're presets over an adapter we already bundle.

### Third-party atom packs (the supported extension point)

Genuinely custom providers are still supported, unchanged, via drop-in atom pack files: place a
`.js` module that default-exports a `ModelProvider` (or an array of them) into
`~/.monad/providers/`. The daemon discovers and watches that directory
(`registry.discover(dir)` + `watchProviders()` in
[`apps/monad/src/services/model.ts`](../apps/monad/src/services/model.ts)), so the atom pack
registers without a restart. The atom pack contract is documented in
[`provider.ts`](../apps/monad/src/agent/model/provider.ts).
