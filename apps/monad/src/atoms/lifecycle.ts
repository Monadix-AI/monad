// Atom pack + channel registry discovery: built-in and third-party atom packs load through the
// SAME atom-kind-gated loader (see ../channels.ts), routing tools/connectors/commands/providers/
// hooks/workspace-experiences/agent-adapters/sandbox-launchers into the daemon's live registries.
// This must run BEFORE the agent snapshots its tools, so a third-party atom pack's declared tools/
// connectors reach the agent from the first turn.

import type { MonadConfig, MonadPaths } from '@monad/home';
import type { AtomDescriptor } from '@monad/protocol';
import type { ModelSubsystem } from '#/agent/model/lifecycle.ts';
import type { AtomConflict } from '#/atoms/resolve.ts';
import type { CapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import type { ConfigSnapshot } from '#/config/service.ts';
import type { AtomPackRegistry } from '#/handlers/atom-pack/index.ts';
import type { CommandRegistry } from '#/handlers/commands/index.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { ModelService } from '#/services/model.ts';

import { registerSandboxLauncher } from '#/capabilities/tools';
import { createChannelRegistry } from '#/channels/discovery.ts';
import { createWorkspaceExperienceSnapshot } from '#/handlers/atom-pack/atom-pack-content.ts';
import { HostInteractionService } from '#/interactions/service.ts';
import { finalizeSandboxLauncher } from '#/platform/sandbox/service.ts';
import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';

export interface AtomDiscovery {
  channelRegistry: Awaited<ReturnType<typeof createChannelRegistry>>;
  atomConflicts: AtomConflict[];
  atomDetailsByPack: Map<string, AtomDescriptor[]>;
  refreshWorkspaceExperienceSnapshot: () => Promise<void>;
  getWorkspaceExperienceSnapshot: () =>
    | Awaited<ReturnType<typeof createWorkspaceExperienceSnapshot>>['experiences']
    | undefined;
}

export async function createAtomDiscovery(deps: {
  paths: MonadPaths;
  cfg: MonadConfig;
  registry: AtomPackRegistry;
  commandRegistry: CommandRegistry;
  modelService: ModelService;
  logger: { warn: (msg: string) => void };
  interactions: HostInteractionService;
}): Promise<AtomDiscovery> {
  const { paths, cfg, registry, commandRegistry, modelService, logger, interactions } = deps;

  // Bare-name collisions surfaced from the latest load sweep (channel/connector/command),
  // mutated in place so the read accessor handed to the atoms module stays valid across re-discovery.
  const atomConflicts: AtomConflict[] = [];
  // Per-pack individual atoms from the latest sweep (packId → its atoms), read by the atom-pack
  // manager for the detail view. Mutated in place so the accessor stays valid across re-discovery.
  const atomDetailsByPack = new Map<string, AtomDescriptor[]>();
  let workspaceExperienceSnapshot:
    | Awaited<ReturnType<typeof createWorkspaceExperienceSnapshot>>['experiences']
    | undefined;
  async function refreshWorkspaceExperienceSnapshot(): Promise<void> {
    const snapshot = await createWorkspaceExperienceSnapshot(paths.packs, [...registry.workspaceExperiences.values()]);
    workspaceExperienceSnapshot = snapshot.experiences;
    for (const warning of snapshot.warnings) {
      logger.warn(`monad: workspace experience "${warning.experienceId}" is not serviceable: ${warning.error}`);
    }
  }
  const channelRegistry = await createChannelRegistry(paths, {
    builtin: {
      onConnector: (c) => registry.registerConnector(c),
      // First-party commands are reserved (non-overridable). atomPackName is ignored — they are built-ins.
      onCommand: (_atomPackName, cmd) =>
        commandRegistry.registerBuiltin(cmd as Parameters<typeof commandRegistry.registerBuiltin>[0]),
      onProvider: (p) => modelService.registry.register(p),
      onHook: (h) => registry.registerHook(h),
      onWorkspaceExperienceApi: (api, atomPackId) => registry.registerWorkspaceExperienceApi(api, atomPackId),
      onWorkspaceExperience: (experience, atomPackId) => registry.registerWorkspaceExperience(experience, atomPackId),
      // Built-in agent-adapter atoms (Codex/Claude Code/Gemini/Qwen) register into the external agent
      // registry keyed by provider — the same gated path a third-party adapter pack would take.
      onAgentAdapter: (a) => registerAgentAdapterImpl(a),
      // Built-in sandbox launchers (Seatbelt/Landlock/Low-Integrity) register into the launcher
      // registry; finalizeSandboxLauncher() below picks one per platform. Boot-only: not wired into
      // the rediscovery sweep, so a hot-installed launcher takes effect on the next daemon start.
      onSandbox: (l) => registerSandboxLauncher(l, 'builtin'),
      onRequestInteraction: (atomPackId, request) =>
        interactions.request({ kind: 'builtin', id: atomPackId, label: atomPackId }, request, { mode: 'background' })
    },
    discovered: {
      onConnector: (c) => registry.registerConnector(c),
      // Third-party atom commands register through the SAME registry as built-ins; built-in
      // names are reserved, so an atom cannot shadow /reset, /model, etc. (rejected + warned).
      onCommand: (atomName, cmd) => commandRegistry.registerAtom(atomName, cmd),
      // An atom declaring the `provider` capability registers its model providers into the model
      // registry — the same path first-party providers take, no special privilege. Globally unique:
      // a type already owned by a built-in (the reserved set createChannelRegistry derives from the
      // built-in pass) is a hard error, not an override.
      onProvider: (p) => modelService.registry.register(p),
      // Namespace-coexist pins: bare name resolves to the user pin (atomPins.<kind>) or first-wins.
      channelPins: cfg.atomPins.channel,
      connectorPins: cfg.atomPins.connector,
      onCollision: (c) => atomConflicts.push(c),
      // An atom pack declaring the `hook` capability registers lifecycle hooks into the registry,
      // which the HookRunner reads alongside config.json command hooks.
      onHook: (h) => registry.registerHook(h),
      onWorkspaceExperienceApi: (api, atomPackId) => registry.registerWorkspaceExperienceApi(api, atomPackId),
      onWorkspaceExperience: (experience, atomPackId) => registry.registerWorkspaceExperience(experience, atomPackId),
      // A discovered pack declaring the `agent-adapter` capability registers external agent adapters into
      // the same registry as built-ins; last registration wins, so a third-party pack can override.
      onAgentAdapter: (a) => registerAgentAdapterImpl(a),
      // A discovered pack declaring the `sandbox` capability (e.g. a cloud e2b/Vercel launcher)
      // registers into the launcher registry, preferred over built-ins on select.
      onSandbox: (l) => registerSandboxLauncher(l, 'atom'),
      onAtoms: (packName, atoms) => atomDetailsByPack.set(packName, atoms),
      onRequestInteraction: (packId, request) =>
        interactions.request({ kind: 'atom-pack', packId, atomId: 'pack' }, request, { mode: 'background' })
    }
  });
  // Resolve bare atom-command names to one winner (pin ?? first-wins); each is always reachable as
  // /<packId>.<command> regardless. Built-in reserved names are untouched.
  commandRegistry.resolvePins(cfg.atomPins.command, (c) => atomConflicts.push(c));
  void refreshWorkspaceExperienceSnapshot().catch((err) =>
    logger.warn(`monad: workspace experience warmup failed: ${err instanceof Error ? err.message : String(err)}`)
  );
  // The sandbox launcher atoms have now registered (any discovered heavy pack) — select the light OS
  // launcher (default) or the configured heavy backend and wire it into the spawn seam.
  await finalizeSandboxLauncher(cfg, process.platform, paths);

  return {
    channelRegistry,
    atomConflicts,
    atomDetailsByPack,
    refreshWorkspaceExperienceSnapshot,
    getWorkspaceExperienceSnapshot: () => workspaceExperienceSnapshot
  };
}

export interface AtomsLifecycleOptions {
  initial: ConfigSnapshot;
  paths: MonadPaths;
  logger: { warn(message: string): void };
  interactions?: HostInteractionService;
}

export function createAtomsLifecycleModule(
  options: AtomsLifecycleOptions,
  discover: typeof createAtomDiscovery = createAtomDiscovery
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'atoms',
    criticality: 'required',
    requires: ['capabilities', 'agent.model'],
    start: (context) => {
      const capabilities = context.get<CapabilitiesRuntime>('capabilities');
      const model = context.get<ModelSubsystem>('agent.model');
      return discover({
        paths: options.paths,
        cfg: options.initial.cfg,
        registry: capabilities.registry,
        commandRegistry: capabilities.commandRegistry,
        modelService: model.modelService,
        logger: options.logger,
        interactions: options.interactions ?? new HostInteractionService()
      });
    }
  };
}
