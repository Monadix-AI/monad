// Bridges the unified atom pack loader to the channel registry. Builtin (first-party) and
// discovered (third-party) atom packs both load through loadManifestAtomPack into this host —
// so a channel atom's declared `channel` atom kind is enforced the same way for everyone.
// registerChannel collects type→factory; commands are forwarded to optional sinks (the
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
  WorkplaceExperiencePermission
} from '@monad/protocol';
import type {
  AtomPackLog,
  ChannelAdapterFactory,
  ChannelDefinition,
  ExperienceWorker,
  HookDefinition,
  ManifestAtomPack,
  ManifestAtomPackHost,
  MeshAgentProviderAdapter,
  ModelProvider,
  SandboxLauncher,
  WorkplaceExperienceApi,
  WorkplaceExperienceDefinition
} from '@monad/sdk-atom';
import type { AtomPackTrustDecision } from '#/atoms/trust.ts';

import { registerMessageType } from '@monad/protocol';
import { loadManifestAtomPack } from '@monad/sdk-atom';

import { assertAtomPackMonadCompatibility, assertAtomPackSdkCompatibility } from '#/atoms/compat.ts';
import { describeAtomPack } from '#/atoms/describe.ts';
import { type AtomConflict, qualifiedAtomName, resolveAtomPins } from '#/atoms/resolve.ts';

interface ChannelAtomPackHostOptions {
  /** Receives each command an atom pack registers (atom-kind-gated like the others). */
  onCommand?: (command: unknown) => void;
  /** Receives each model provider an atom pack registers (atom-kind-gated like the others). */
  onProvider?: (provider: ModelProvider) => void;
  /** Receives each lifecycle hook an atom pack registers (atom-kind-gated like the others). */
  onHook?: (hook: HookDefinition) => void;
  /** Receives each MeshAgent provider adapter an atom pack registers. */
  onAgentAdapter?: (adapter: MeshAgentProviderAdapter) => void;
  /** Receives each sandbox launcher an atom pack registers (atom-kind-gated like the others). The
   *  daemon collects them into a registry and selects one per platform — no namespace/first-wins
   *  here (selection is by platform + availability, third-party preferred over built-in). */
  onSandbox?: (launcher: SandboxLauncher, atomPackId: string) => void;
  /** Receives each workplace experience an atom pack registers (atom-kind-gated like the others),
   *  together with the permissions its manifest declared — the host stamps those onto the definition
   *  so the Web host can restrict the action surface it hands the experience. */
  onWorkplaceExperience?: (
    experience: WorkplaceExperienceDefinition,
    atomPackName: string,
    permissions: readonly WorkplaceExperiencePermission[]
  ) => void;
  /** Receives each workplace experience API route set an atom pack registers (same atom-kind gate). */
  onWorkplaceExperienceApi?: (
    api: WorkplaceExperienceApi,
    atomPackName: string,
    permissions: readonly WorkplaceExperiencePermission[]
  ) => void;
  onExperienceWorker?: (
    worker: ExperienceWorker,
    atomPackName: string,
    permissions: readonly WorkplaceExperiencePermission[]
  ) => void;
  /** Receives a schema-only interaction request with the loader-bound, trusted pack identity. */
  onRequestInteraction?: (atomPackId: string, request: InteractionRequest) => Promise<InteractionResult>;
  /** Name of the atom pack currently being loaded — used to attribute collisions (same-pack dup vs
   *  cross-pack). The loader updates the source before each pack; absent → '' (single-pack callers). */
  currentAtomPack?: () => string;
  currentWorkplaceExperiencePermissions?: () => readonly WorkplaceExperiencePermission[];
  /** Whether the pack currently loading may contribute workplace experiences. Absent → trusted
   *  (the built-in pass). */
  currentWorkplaceExperienceTrust?: () => AtomPackTrustDecision;
  /** Provider types already owned by a prior load pass (e.g. the built-in providers). A `provider`
   *  atom is GLOBALLY UNIQUE — claiming a reserved type throws (hard fail), so a third-party pack
   *  cannot shadow a built-in provider like `openai` to hijack its routing/credentials. */
  reservedProviderTypes?: ReadonlySet<string>;
  /** User pins for the `channel` kind: bare type → packId. Resolves the bare name when several packs
   *  register the same channel type; unset → first-wins by load order. */
  channelPins?: Readonly<Record<string, string>>;
  /** Structured bare-name collision report for the conflict UI. */
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
} {
  const channels = new Map<ChannelType, ChannelAdapterFactory>();
  // Channels namespace-coexist: each is registered as `<packId>__<type>` (always addressable) and
  // collected as a candidate; the bare `<type>` is resolved to one winner in finalizeChannels.
  const channelCandidates: { type: ChannelType; packId: string; create: ChannelAdapterFactory }[] = [];
  const providerOwners = new Map<string, string>();
  const pack = () => opts.currentAtomPack?.() ?? '';
  // A workplace experience runs in-process in the Web host and drives project state, so an atom-kind
  // grant alone is not enough — the pack must also be accepted for this kind. Refusing just the
  // experience atoms (rather than throwing) keeps the pack's channels/providers/hooks loading.
  const acceptedForExperiences = (what: string): boolean => {
    const trust = opts.currentWorkplaceExperienceTrust?.() ?? { trusted: true, reasons: [] };
    if (trust.trusted) return true;
    opts.log?.('warn', `${what} from "${pack()}" refused: ${trust.reasons.join('; ')}`);
    return false;
  };
  const host: ManifestAtomPackHost = {
    registerChannel: (def: ChannelDefinition) => {
      const pk = pack();
      // Same-pack duplicate type is an authoring bug → abort the pack (consistent with other kinds).
      if (channelCandidates.some((c) => c.packId === pk && c.type === def.type)) {
        throw new Error(`Atom Pack "${pk}" registers duplicate channel type "${def.type}"`);
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
          `provider type "${p.type}" already registered by Atom Pack "${owner}"; provider types are globally unique`
        );
      }
      providerOwners.set(p.type, pack());
      opts.onProvider?.(p);
    },
    registerHook: (h) => opts.onHook?.(h),
    registerAgentAdapter: (a) => opts.onAgentAdapter?.(a),
    registerSandbox: (s) => opts.onSandbox?.(s, pack()),
    registerWorkplaceExperienceApi: (api) => {
      if (!acceptedForExperiences(`workplace experience API routes for "${api.experienceId}"`)) return;
      opts.onWorkplaceExperienceApi?.(api, pack(), opts.currentWorkplaceExperiencePermissions?.() ?? []);
    },
    registerExperienceWorker: (worker) => {
      if (!acceptedForExperiences(`workplace experience worker for "${worker.experienceId}"`)) return;
      opts.onExperienceWorker?.(worker, pack(), opts.currentWorkplaceExperiencePermissions?.() ?? []);
    },
    registerWorkplaceExperience: (experience) => {
      if (!acceptedForExperiences(`workplace experience "${experience.id}"`)) return;
      opts.onWorkplaceExperience?.(experience, pack(), opts.currentWorkplaceExperiencePermissions?.() ?? []);
    },
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
  return { host, channels, finalizeChannels };
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
  grantedPermissionsFor?: (atomPack: ManifestAtomPack) => readonly WorkplaceExperiencePermission[] | undefined;
  /** Whether a pack was accepted for the `workplace-experience` kind. Omit for first-party packs. */
  experienceTrustFor?: (atomPack: ManifestAtomPack) => AtomPackTrustDecision | undefined;
  /** The pack's stable identity (its install-dir/folder name) for qualified names + pins + conflict
   *  reporting. Unique even when two packs share a manifest name. Falls back to manifest.name. */
  packIdFor?: (atomPack: ManifestAtomPack) => string | undefined;
  /** Receives each successfully-loaded pack's individual atoms (id/name/description per kind) so the
   *  atom-pack manager can surface a per-atom detail view, not just the manifest's kind list. */
  onAtoms?: (atomPackName: string, atoms: AtomDescriptor[]) => void;
  /** Receives each pack whose `register()` completed, so a caller tracking the live set can
   *  deactivate the packs a later sweep drops. */
  onPackLoaded?: (atomPackId: string, atomPack: ManifestAtomPack) => void;
};

/** Load each atom pack through the atom-kind-gated loader, collecting their channels. Per-atom-pack
 *  non-fatal: a failed atom pack (incl. UndeclaredAtomError) is reported, never blocks others. */
export async function loadChannelAtomPacks(
  atomPacks: ManifestAtomPack[],
  opts: LoadChannelAtomPacksOptions = {}
): Promise<Map<ChannelType, ChannelAdapterFactory>> {
  let currentAtomPack = '';
  let currentWorkplaceExperiencePermissions: readonly WorkplaceExperiencePermission[] = [];
  let currentWorkplaceExperienceTrust: AtomPackTrustDecision = { trusted: true, reasons: [] };
  const { host, channels, finalizeChannels } = createChannelAtomPackHost({
    onProvider: opts.onProvider,
    onHook: opts.onHook,
    onAgentAdapter: opts.onAgentAdapter,
    onSandbox: opts.onSandbox,
    onWorkplaceExperience: opts.onWorkplaceExperience,
    onWorkplaceExperienceApi: opts.onWorkplaceExperienceApi,
    onExperienceWorker: opts.onExperienceWorker,
    onRequestInteraction: opts.onRequestInteraction,
    reservedProviderTypes: opts.reservedProviderTypes,
    channelPins: opts.channelPins,
    onCollision: opts.onCollision,
    log: opts.log,
    currentAtomPack: () => currentAtomPack,
    currentWorkplaceExperiencePermissions: () => currentWorkplaceExperiencePermissions,
    currentWorkplaceExperienceTrust: () => currentWorkplaceExperienceTrust,
    onCommand: opts.onCommand ? (cmd) => opts.onCommand?.(currentAtomPack, cmd) : undefined
  });
  for (const atomPack of atomPacks) {
    try {
      assertAtomPackSdkCompatibility(atomPack.manifest.name, atomPack.manifest.sdkVersion);
    } catch (error) {
      opts.onError?.(atomPack.manifest.name, error instanceof Error ? error : new Error(String(error)));
      continue;
    }
    currentAtomPack = opts.packIdFor?.(atomPack) ?? atomPack.manifest.name;
    currentWorkplaceExperiencePermissions =
      opts.grantedPermissionsFor?.(atomPack) ?? atomPack.manifest.permissions ?? [];
    currentWorkplaceExperienceTrust = opts.experienceTrustFor?.(atomPack) ?? { trusted: true, reasons: [] };
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
      opts.onPackLoaded?.(currentAtomPack, atomPack);
    } catch (err) {
      opts.onError?.(atomPack.manifest.name, err);
    }
  }
  finalizeChannels(); // resolve bare channel types to one winner (pin ?? first-wins) after the sweep
  return channels;
}
