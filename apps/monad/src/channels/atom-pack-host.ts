// Bridges the unified atom pack loader to the channel registry. Builtin (first-party) and
// discovered (third-party) atom packs both load through loadManifestAtomPack into this host —
// so a channel atom's declared `channel` atom kind is enforced the same way for everyone.
// registerChannel collects type→factory; connectors/commands are forwarded to optional sinks (the
// daemon wires them into their respective registries, including on rediscovery after an atom pack
// install). Tools are NOT an atom kind — they are first-party only and never registered here.
//
// skill/mcp/locale are file-based and do NOT flow through this host — they are installed at the
// atom-pack-manager level and discovered from disk at daemon startup.

import type {
  AtomDescriptor,
  AtomKind,
  ChannelType,
  InteractionRequest,
  InteractionResult,
  WorkspaceExperiencePermission
} from '@monad/protocol';
import type {
  AtomPackLog,
  ChannelAdapterFactory,
  ChannelDefinition,
  Connector,
  ExperienceWorker,
  ExternalAgentProviderAdapter,
  HookDefinition,
  ManifestAtomPack,
  ManifestAtomPackHost,
  ModelProvider,
  SandboxLauncher,
  WorkspaceExperienceApi,
  WorkspaceExperienceDefinition
} from '@monad/sdk-atom';

import { registerMessageType } from '@monad/protocol';
import { loadManifestAtomPack, SDK_VERSION } from '@monad/sdk-atom';

import { assertAtomPackMonadCompatibility } from '#/atoms/compat.ts';
import { describeAtomPack } from '#/atoms/describe.ts';
import { type AtomConflict, qualifiedAtomName, resolveAtomPins } from '#/atoms/resolve.ts';

interface ChannelAtomPackHostOptions {
  onConnector?: (connector: Connector) => void;
  /** Receives each command an atom pack registers (atom-kind-gated like the others). */
  onCommand?: (command: unknown) => void;
  /** Receives each model provider an atom pack registers (atom-kind-gated like the others). */
  onProvider?: (provider: ModelProvider) => void;
  /** Receives each lifecycle hook an atom pack registers (atom-kind-gated like the others). */
  onHook?: (hook: HookDefinition) => void;
  /** Receives each external agent provider adapter an atom pack registers. */
  onAgentAdapter?: (adapter: ExternalAgentProviderAdapter) => void;
  /** Receives each sandbox launcher an atom pack registers (atom-kind-gated like the others). The
   *  daemon collects them into a registry and selects one per platform — no namespace/first-wins
   *  here (selection is by platform + availability, third-party preferred over built-in). */
  onSandbox?: (launcher: SandboxLauncher, atomPackId: string) => void;
  /** Receives each workspace experience an atom pack registers (atom-kind-gated like the others). */
  onWorkspaceExperience?: (experience: WorkspaceExperienceDefinition, atomPackName: string) => void;
  /** Receives each workspace experience API route set an atom pack registers (same atom-kind gate). */
  onWorkspaceExperienceApi?: (
    api: WorkspaceExperienceApi,
    atomPackName: string,
    permissions: readonly WorkspaceExperiencePermission[]
  ) => void;
  onExperienceWorker?: (
    worker: ExperienceWorker,
    atomPackName: string,
    permissions: readonly WorkspaceExperiencePermission[]
  ) => void;
  /** Receives a schema-only interaction request with the loader-bound, trusted pack identity. */
  onRequestInteraction?: (atomPackId: string, request: InteractionRequest) => Promise<InteractionResult>;
  /** Name of the atom pack currently being loaded — used to attribute collisions (same-pack dup vs
   *  cross-pack). The loader updates the source before each pack; absent → '' (single-pack callers). */
  currentAtomPack?: () => string;
  currentWorkspaceExperiencePermissions?: () => readonly WorkspaceExperiencePermission[];
  /** Provider types already owned by a prior load pass (e.g. the built-in providers). A `provider`
   *  atom is GLOBALLY UNIQUE — claiming a reserved type throws (hard fail), so a third-party pack
   *  cannot shadow a built-in provider like `openai` to hijack its routing/credentials. */
  reservedProviderTypes?: ReadonlySet<string>;
  /** User pins for the `channel` kind: bare type → packId. Resolves the bare name when several packs
   *  register the same channel type; unset → first-wins by load order. */
  channelPins?: Readonly<Record<string, string>>;
  /** User pins for the `connector` kind (bare name → packId), same resolution as channelPins. */
  connectorPins?: Readonly<Record<string, string>>;
  /** Structured bare-name collision report (channel/connector) for the conflict UI. */
  onCollision?: (conflict: AtomConflict) => void;
  log?: AtomPackLog;
}

function createChannelAtomPackHost(opts: ChannelAtomPackHostOptions = {}): {
  host: ManifestAtomPackHost;
  channels: Map<ChannelType, ChannelAdapterFactory>;
  /** Resolve bare channel types after all packs in this sweep have registered: every channel is
   *  already addressable as `<packId>__<type>`; this sets the bare `<type>` to the winner (pin ?? the
   *  first pack by load order). Call once after the load loop. */
  finalizeChannels: () => void;
  /** Forward collected connectors after the sweep: winner under the bare name, shadowed losers
   *  under `<packId>__<name>`. Call once after the load loop. */
  finalizeConnectors: () => void;
} {
  const channels = new Map<ChannelType, ChannelAdapterFactory>();
  // Channels namespace-coexist: each is registered as `<packId>__<type>` (always addressable) and
  // collected as a candidate; the bare `<type>` is resolved to one winner in finalizeChannels.
  const channelCandidates: { type: ChannelType; packId: string; create: ChannelAdapterFactory }[] = [];
  // connectors namespace-coexist like channels, but they're name-keyed in external registries:
  // the WINNER (pin ?? first-wins) keeps the bare name; only SHADOWED losers are forwarded under the
  // qualified `<packId>__<name>`. provider is hard-unique (see registerProvider).
  const providerOwners = new Map<string, string>();
  const connectorCandidates: { name: string; packId: string; value: Connector }[] = [];
  const pack = () => opts.currentAtomPack?.() ?? '';
  const host: ManifestAtomPackHost = {
    registerConnector: (c) => {
      const pk = pack();
      if (connectorCandidates.some((x) => x.packId === pk && x.name === c.name)) {
        throw new Error(`atom pack "${pk}" registers duplicate connector "${c.name}"`);
      }
      connectorCandidates.push({ name: c.name, packId: pk, value: c });
    },
    registerChannel: (def: ChannelDefinition) => {
      const pk = pack();
      // Same-pack duplicate type is an authoring bug → abort the pack (consistent with other kinds).
      if (channelCandidates.some((c) => c.packId === pk && c.type === def.type)) {
        throw new Error(`atom pack "${pk}" registers duplicate channel type "${def.type}"`);
      }
      // Always addressable under the qualified name; the bare type is resolved in finalizeChannels.
      channels.set(pk ? qualifiedAtomName(pk, def.type) : def.type, def.create);
      channelCandidates.push({ type: def.type, packId: pk, create: def.create });
    },
    registerCommand: (cmd) => opts.onCommand?.(cmd),
    registerMessageType: (atomPackId, d) => registerMessageType(atomPackId, d),
    registerProvider: (p) => {
      // provider is GLOBALLY UNIQUE (the gateway routing key + credential binding key): no
      // first-wins, no namespace — a duplicate is a hard error that aborts the offending pack.
      if (opts.reservedProviderTypes?.has(p.type)) {
        throw new Error(`provider type "${p.type}" is reserved by a built-in provider; "${pack()}" cannot redefine it`);
      }
      const owner = providerOwners.get(p.type);
      if (owner !== undefined) {
        throw new Error(
          `provider type "${p.type}" already registered by atom pack "${owner}"; provider types are globally unique`
        );
      }
      providerOwners.set(p.type, pack());
      opts.onProvider?.(p);
    },
    registerHook: (h) => opts.onHook?.(h),
    registerAgentAdapter: (a) => opts.onAgentAdapter?.(a),
    registerSandbox: (s) => opts.onSandbox?.(s, pack()),
    registerWorkspaceExperienceApi: (api) =>
      opts.onWorkspaceExperienceApi?.(api, pack(), opts.currentWorkspaceExperiencePermissions?.() ?? []),
    registerExperienceWorker: (worker) =>
      opts.onExperienceWorker?.(worker, pack(), opts.currentWorkspaceExperiencePermissions?.() ?? []),
    registerWorkspaceExperience: (experience) => opts.onWorkspaceExperience?.(experience, pack()),
    requestInteraction: (atomPackId, request) =>
      opts.onRequestInteraction?.(atomPackId, request) ??
      Promise.resolve({ status: 'cancelled', reason: 'unavailable' }),
    log: opts.log
  };
  const finalizeChannels = (): void => {
    const { winners, collisions } = resolveAtomPins(
      channelCandidates.map((c) => ({ bareId: c.type, packId: c.packId })),
      opts.channelPins ?? {}
    );
    for (const [type, winnerPack] of winners) {
      const winner = channelCandidates.find((c) => c.type === type && c.packId === winnerPack);
      if (winner) channels.set(type, winner.create);
    }
    for (const col of collisions) {
      opts.onCollision?.({ kind: 'channel', ...col });
      opts.log?.(
        'warn',
        `channel type "${col.bareId}": "${col.winner}" active; shadowed ${col.shadowed.join(', ')} — use <packId>__${col.bareId} to address a specific one`
      );
    }
  };
  // connector finalize: winner keeps the bare name; shadowed losers go out under the qualified
  // name (so they stay reachable without bloating the common no-collision case).
  function finalizeNamed<V extends { name: string }>(
    candidates: { name: string; packId: string; value: V }[],
    pins: Readonly<Record<string, string>> | undefined,
    forward: ((v: V, sourceName: string) => void) | undefined,
    rename: (v: V, name: string) => V,
    kind: 'connector'
  ): void {
    if (!forward) return;
    const { winners, collisions } = resolveAtomPins(
      candidates.map((c) => ({ bareId: c.name, packId: c.packId })),
      pins ?? {}
    );
    for (const c of candidates) {
      forward(
        c.packId === winners.get(c.name) ? c.value : rename(c.value, qualifiedAtomName(c.packId, c.name)),
        c.packId
      );
    }
    for (const col of collisions) {
      opts.onCollision?.({ kind, ...col });
      opts.log?.(
        'warn',
        `${kind} "${col.bareId}": "${col.winner}" active; shadowed ${col.shadowed.join(', ')} — reachable as <packId>__${col.bareId}`
      );
    }
  }
  const finalizeConnectors = (): void => {
    finalizeNamed(
      connectorCandidates,
      opts.connectorPins,
      opts.onConnector,
      (c, name) => ({ ...c, name }),
      'connector'
    );
  };
  return { host, channels, finalizeChannels, finalizeConnectors };
}

export type LoadChannelAtomPacksOptions = Omit<ChannelAtomPackHostOptions, 'onCommand'> & {
  onError?: (atomPack: string, error: unknown) => void;
  /** Receives (atomPackName, command) so the core registry can attribute + de-conflict commands. */
  onCommand?: (atomPackName: string, command: unknown) => void;
  /** The AUTHORITATIVE per-pack atom-kind grant (the consented on-disk `atom-pack.json` atoms),
   *  keyed by pack object identity. When it returns a set for a pack, that set gates the pack
   *  instead of the bundle's self-declared `manifest.atoms` — closing the consent-bypass where a
   *  bundle embeds more atoms than the user consented to. Omit for first-party/trusted packs. */
  grantedAtomsFor?: (atomPack: ManifestAtomPack) => readonly AtomKind[] | undefined;
  grantedPermissionsFor?: (atomPack: ManifestAtomPack) => readonly WorkspaceExperiencePermission[] | undefined;
  /** The pack's stable identity (its install-dir/folder name) for qualified names + pins + conflict
   *  reporting. Unique even when two packs share a manifest name. Falls back to manifest.name. */
  packIdFor?: (atomPack: ManifestAtomPack) => string | undefined;
  /** Receives each successfully-loaded pack's individual atoms (id/name/description per kind) so the
   *  atom-pack manager can surface a per-atom detail view, not just the manifest's kind list. */
  onAtoms?: (atomPackName: string, atoms: AtomDescriptor[]) => void;
};

/** Load each atom pack through the atom-kind-gated loader, collecting their channels. Per-atom-pack
 *  non-fatal: a failed atom pack (incl. UndeclaredAtomError) is reported, never blocks others. */
export async function loadChannelAtomPacks(
  atomPacks: ManifestAtomPack[],
  opts: LoadChannelAtomPacksOptions = {}
): Promise<Map<ChannelType, ChannelAdapterFactory>> {
  let currentAtomPack = '';
  let currentWorkspaceExperiencePermissions: readonly WorkspaceExperiencePermission[] = [];
  const { host, channels, finalizeChannels, finalizeConnectors } = createChannelAtomPackHost({
    onConnector: opts.onConnector,
    onProvider: opts.onProvider,
    onHook: opts.onHook,
    onAgentAdapter: opts.onAgentAdapter,
    onSandbox: opts.onSandbox,
    onWorkspaceExperience: opts.onWorkspaceExperience,
    onWorkspaceExperienceApi: opts.onWorkspaceExperienceApi,
    onExperienceWorker: opts.onExperienceWorker,
    onRequestInteraction: opts.onRequestInteraction,
    reservedProviderTypes: opts.reservedProviderTypes,
    channelPins: opts.channelPins,
    connectorPins: opts.connectorPins,
    onCollision: opts.onCollision,
    log: opts.log,
    currentAtomPack: () => currentAtomPack,
    currentWorkspaceExperiencePermissions: () => currentWorkspaceExperiencePermissions,
    onCommand: opts.onCommand ? (cmd) => opts.onCommand?.(currentAtomPack, cmd) : undefined
  });
  for (const atomPack of atomPacks) {
    if (atomPack.manifest.sdkVersion !== SDK_VERSION) {
      opts.onError?.(
        atomPack.manifest.name,
        new Error(`incompatible sdkVersion ${atomPack.manifest.sdkVersion} (daemon: ${SDK_VERSION})`)
      );
      continue;
    }
    currentAtomPack = opts.packIdFor?.(atomPack) ?? atomPack.manifest.name;
    currentWorkspaceExperiencePermissions =
      opts.grantedPermissionsFor?.(atomPack) ?? atomPack.manifest.permissions ?? [];
    try {
      assertAtomPackMonadCompatibility(atomPack.manifest.name, atomPack.manifest.monadVersion);
      // Description is metadata for the operator-facing detail view, not a side effect of runtime
      // registration. Capture it first so a failing sink (for example a duplicate sandbox launcher)
      // does not collapse an otherwise inspectable pack back to kind-only badges.
      if (opts.onAtoms) opts.onAtoms(currentAtomPack, await describeAtomPack(atomPack));
      await loadManifestAtomPack(atomPack, host, {
        grantedAtoms: opts.grantedAtomsFor?.(atomPack),
        atomPackId: currentAtomPack
      });
    } catch (err) {
      opts.onError?.(atomPack.manifest.name, err);
    }
  }
  finalizeChannels(); // resolve bare channel types to one winner (pin ?? first-wins) after the sweep
  finalizeConnectors(); // forward connectors: winner bare, shadowed losers qualified
  return channels;
}
