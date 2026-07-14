# Sandbox backends

Sandbox policy and sandbox backend are independent. Policy controls filesystem access, confinement, network access, allowed domains, and host execution. The backend is the launcher that applies that policy to newly spawned processes.

`/studio/sandbox` displays both, but activating a backend does not rewrite policy. Backend changes are hot: existing processes remain owned by the launcher that created them, while processes spawned after a successful activation use the new launcher.

## Built-in and contributed backends

Built-in `auto` selects the best available lightweight OS sandbox. Built-in `vm` is explicitly selected and is never provided by Power Pack.

Docker and E2B are contributed by an enabled atom pack. Core protocol, daemon settings, and Studio do not contain Docker- or E2B-specific UI branches. Every backend is identified by its source-qualified reference:

```ts
type SandboxBackendRef =
  | { source: 'builtin'; kind: string }
  | { source: 'atom-pack'; packId: string; kind: string };
```

This keeps two packs that use the same `kind` isolated from one another.

## Contributing a backend

A launcher declares a serializable descriptor and an optional settings schema:

```ts
const launcher: SandboxLauncher = {
  kind: 'cloud',
  descriptor: {
    name: 'Cloud sandbox',
    description: 'Runs tools in an isolated remote environment.',
    settings: {
      fields: [
        { id: 'region', type: 'string', label: 'Region', defaultValue: 'us-east' },
        { id: 'apiKey', type: 'secret', label: 'API key', required: true }
      ]
    }
  },
  configure: async (settings) => configureClient(settings),
  prepare: async () => prepareRuntime(),
  isAvailable: () => clientIsReady(),
  spawn: async (request) => spawnIsolated(request)
};
```

The available field types are `string`, `number`, `boolean`, `select`, and `secret`. Studio renders this schema generically. A launcher may also use Host Interaction for a setup flow that needs an immediate user response; see [host-interactions.md](../internals/host-interactions.md).

Descriptors cannot include frontend code, HTML, scripts, callbacks, or executable validation. Platform support and enforcement claims are data, not custom presentation instructions.

## Settings and secrets

The host validates and stores settings under the backend's source-qualified key. Disabling a pack leaves those settings intact so reinstalling the same stable pack identity can restore them.

Secret fields are different from ordinary settings:

- plaintext is stored only in the host secret store;
- sandbox configuration contains a generated `${secret:...}` reference;
- read APIs return `{ configured: true }`, never the value or reference target;
- an empty secret input means no change;
- replacement and removal are explicit actions;
- resolved values are passed to `configure()` only inside the daemon.

E2B requires an API key supplied through its contributed secret field. Docker requires a working Docker-compatible runtime and may declare an image setting. These requirements belong to the contributed descriptors and launcher implementation, not to host UI logic.

## Activation transaction

Activation is serialized and follows this order:

1. Validate candidate settings.
2. Resolve secrets inside the daemon.
3. Configure and prepare the candidate.
4. Probe availability.
5. Atomically swap the active launcher.
6. Persist the backend settings and active selection.
7. Dispose idle resources owned by the previous backend.

Candidate preparation happens while the old backend keeps serving. Validation, preparation, or availability failure leaves both runtime and persisted selection unchanged. Persistence failure swaps runtime back. Cleanup failure keeps the successful new activation, reports a warning, and retries cleanup asynchronously.

Disabling or removing the pack that owns the active backend first activates built-in `auto`. If the safe fallback cannot be established, the pack operation is refused. No transition temporarily selects an unconfined launcher.

## Compatibility

Backend discovery and activation use transport-neutral protocol objects. Studio is one presenter, not part of the backend contract. CLI, TUI, and ACP clients receive the same Host Interaction semantics and never need provider-specific UI code.
