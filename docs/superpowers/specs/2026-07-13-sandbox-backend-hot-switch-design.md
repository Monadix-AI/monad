# Sandbox Backend Hot-Switch Design

## Goal

Turn `/studio/sandbox` into the control surface for discovering, configuring, and safely hot-switching sandbox backends. The host must support built-in and atom-pack-contributed backends without coupling the protocol, daemon, or web UI to specific third-party implementations such as Docker or E2B.

## Product model

Sandbox policy and sandbox backend are separate concerns:

- Policy controls filesystem mode, confinement, network access, allowed domains, host execution, and the global ceiling.
- Backend selects the launcher that enforces the policy for newly spawned tool processes.

The page presents both in one place but preserves this boundary in APIs and code.

Backends are grouped by source:

- Built-in: `auto` and `vm`.
- Installed: launchers contributed by enabled atom packs. Docker and E2B are examples, not host-defined concepts.

`auto` resolves to the best available lightweight built-in launcher for the host platform, such as Seatbelt, bwrap, Landlock, AppContainer, or Low Integrity. VM is built into the daemon but remains explicitly selected and is never chosen by `auto`.

## Sandbox launcher contract

`SandboxLauncher` gains a serializable descriptor and optional declarative settings contract. The launcher remains responsible for runtime behavior; the host owns persistence, secret storage, validation, and rendering.

```ts
interface SandboxLauncherDescriptor {
  name: string;
  description?: string;
  settings?: SandboxSettingsSchema;
}

interface SandboxLauncher {
  kind: string;
  descriptor: SandboxLauncherDescriptor;
  platforms?: NodeJS.Platform[];
  enforces?: SandboxEnforcement;
  configure?(settings: Record<string, unknown>): void | Promise<void>;
  prepare?(): Promise<void>;
  isAvailable?(): boolean;
  // Existing spawn, wrap, and disposal methods remain.
}
```

The schema is deliberately limited to host-rendered field types:

- `string`
- `number`
- `boolean`
- `select`
- `secret`

Supported validation metadata includes required, min/max, pattern, and select options. The schema cannot contain HTML, executable validation code, React components, or arbitrary frontend scripts.

VM uses the same contract as contributed backends. This prevents a second built-in-only settings path while keeping VM available without an atom pack.

The field schema and user-prompt lifecycle are provided by the transport-neutral Host Interaction contract in `2026-07-13-host-interaction-design.md`. Sandbox owns backend discovery, settings persistence, status, and activation; it does not implement a separate dialog protocol.

## Identity and configuration storage

A backend is identified by source plus kind, not kind alone:

```ts
type SandboxBackendRef =
  | { source: 'builtin'; kind: string }
  | { source: 'atom-pack'; packId: string; kind: string };
```

This permits two installed packs to contribute the same kind without sharing configuration or creating ambiguous activation behavior.

Backend configuration is stored in an opaque, namespaced map owned by the host. Conceptually:

```json
{
  "activeBackend": { "source": "atom-pack", "packId": "vendor-pack", "kind": "cloud" },
  "backendSettings": {
    "builtin/vm": { "cpus": 2, "memory": 2048 },
    "atom-pack/vendor-pack/cloud": { "region": "us-east" }
  }
}
```

Removing or disabling a pack does not delete its settings. Reinstalling the same stable pack identity restores them. Explicit pack removal may offer a separate configuration cleanup action later; it is not part of this scope.

## Secret handling

Fields declared as `secret` never store plaintext in normal sandbox configuration.

- The daemon writes secret values to `auth.json.namedSecrets` under a host-generated backend-scoped name.
- Backend settings contain only a `${secret:...}` reference.
- Read APIs return `{ configured: boolean }`, never the secret value or reference target.
- An empty UI field means no change. Secret deletion requires an explicit remove action.
- Resolved secrets are provided to `launcher.configure()` only inside the daemon.
- Logs, errors, telemetry, and API responses must redact secret values.

The generic mechanism supports E2B-style API keys without the host knowing that E2B exists. Environment references such as `${env:E2B_API_KEY}` can be represented as an advanced string-reference mode without adding an E2B-specific endpoint.

## Discovery and status API

The sandbox settings response includes the active backend and a snapshot of all discoverable backends:

```ts
interface SandboxBackendView {
  ref: SandboxBackendRef;
  descriptor: SandboxLauncherDescriptor;
  sourceLabel: string;
  platforms?: string[];
  enforces?: SandboxEnforcement;
  status: 'active' | 'available' | 'unavailable' | 'preparing' | 'error';
  statusDetail?: string;
  settings: Record<string, unknown>;
}
```

The daemon derives atom-pack attribution from the launcher registry rather than trusting the launcher to self-report its pack. Disabled or unavailable launchers remain visible when their metadata is known, but cannot be activated.

## Hot-switch transaction

Backend activation is an explicit daemon operation, not a side effect of an ordinary config write.

```text
validate settings
  -> resolve secrets
  -> configure candidate launcher
  -> prepare candidate launcher
  -> probe availability
  -> atomically replace active launcher
  -> persist backend and settings
  -> dispose idle resources owned by the previous backend
```

Required semantics:

- The old backend continues serving while the candidate prepares.
- The global launcher changes only after the candidate is ready.
- Processes already running remain attached to the launcher that spawned them.
- New processes use the new launcher after the atomic swap.
- Candidate failure leaves runtime and persisted selection unchanged.
- Persistence failure swaps runtime back to the old launcher and reports failure.
- The transition is serialized so concurrent activation requests cannot interleave.
- Switching away calls the old launcher's disposal hooks for idle session and agent resources. Active work is not killed or migrated.
- Uninstalling or disabling the active backend's pack first activates built-in `auto`; if that safe fallback fails, uninstall/disable is refused.
- No transition may temporarily configure `none` or silently run unconfined.

The activation result reports the requested backend, effective backend, and any failure or fallback reason. A request never claims success when a different backend became effective.

## Studio UI

`/studio/sandbox` contains four sections:

1. Active backend
   - Current backend, source, effective launcher, readiness, and enforcement summary.
2. Available backends
   - Cards grouped into Built-in and Installed.
   - Each card shows name, source pack, platform support, availability, and declared enforcement.
3. Selected backend settings
   - A generic form rendered from the selected launcher's schema.
   - Secret fields show configured state and explicit replace/remove actions.
   - Selecting Activate starts preparation immediately. The active card remains unchanged until success.
4. Sandbox policy
   - The existing mode, confine, network, allowed domains, host execution, and global ceiling controls.

Backend-specific errors appear on the selected card or field. The UI does not contain Docker, E2B, or other contributed-backend conditionals. Built-in VM is also rendered through the generic form.

## Error handling

- Invalid schema: reject the launcher descriptor during discovery and report a pack-scoped error.
- Invalid settings: return structured field errors without calling `configure()`.
- Missing secret: mark the field unconfigured and the backend unavailable.
- Prepare or probe failure: retain the old backend and persisted selection.
- Pack disappears during preparation: cancel activation and retain the old backend.
- Duplicate `{packId, kind}`: reject the duplicate registration.
- Duplicate kinds across different packs: show both using distinct source-qualified identities.
- Old resource disposal failure after a successful switch: keep the new backend active, report a cleanup warning, and retry cleanup asynchronously.

## Testing

Protocol tests cover valid and invalid descriptors, field schemas, redacted secret views, and source-qualified backend references.

Daemon tests cover:

- discovery of contributed launchers in the backend list;
- VM presence without Power Pack;
- isolation for identical kinds from different packs;
- secret write, redaction, replacement, resolution, and deletion;
- failed validation, prepare, availability, and persistence paths;
- serialized activation and atomic rollback;
- old-process/new-process launcher ownership across a switch;
- disposal of idle E2B/VM-style resources;
- safe fallback before disabling or uninstalling an active contributed backend.

Web tests cover:

- generic rendering of all supported field types;
- absence of contributed-backend conditionals;
- Built-in and Installed grouping;
- preparing, success, failure, configured-secret, and unavailable states;
- preservation of the existing policy controls.

Browser E2E covers a successful Built-in-to-Installed switch, a failed switch that retains the old backend, and switching back to Built-in.

## Scope boundaries

This design does not support arbitrary third-party frontend components, migration of already-running processes, automatic selection of heavy contributed backends, or destructive cleanup of saved settings when a pack is removed. Those capabilities require separate designs.
