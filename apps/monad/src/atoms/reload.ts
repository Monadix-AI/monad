// Boot-phase helper: wraps the atom-pack rediscovery sweep (commands / hooks /
// providers / workplace experiences / locales / file-MCP) in a serialised, closure-free factory so main.ts can hand the
// returned function to both the API handler and the fs-watcher without re-capturing local variables.
// Tools are first-party only (wired once at startup) and never part of a rediscovery sweep.

import type { MonadPaths } from '@monad/environment';
import type { AtomDescriptor } from '@monad/protocol';
import type { ManifestAtomPack, ModelProvider } from '@monad/sdk-atom';
import type { AtomConflict } from '#/atoms/resolve.ts';
import type { ConfigAccess } from '#/config/manager.ts';
import type { InteractionService } from '#/interactions/service.ts';

import { defaultLocaleName, loadLocalePacksFromDir } from '@monad/i18n';
import { BUILTIN_LOCALES_DIR } from '@monad/i18n/locale-dir';

import { deactivateAtomPack } from '#/atoms/deactivate.ts';
import { type BuiltinSinks, createChannelRegistry, type DiscoveredSinks } from '#/channels/discovery.ts';
import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import { CommandRegistry } from '#/handlers/commands/registry.ts';
import { I18nService, loadInstalledLocalePacks } from '#/services/i18n.ts';

export type AtomPackRediscovererDeps = {
  paths: MonadPaths;
  config: Pick<ConfigAccess, 'get'>;
  /** Mutated in place: cleared at the start of each sweep, then re-populated. */
  atomConflicts: AtomConflict[];
  /** Per-pack individual atoms (packId → atoms). Mutated in place: cleared then re-populated each sweep. */
  atomDetailsByPack: Map<string, AtomDescriptor[]>;
  /** The packs currently loaded (packId → pack). Mutated in place so the sweep can tell which packs
   *  a reload dropped and deactivate exactly those. Seeded by the boot load. */
  activeAtomPacks: Map<string, ManifestAtomPack>;
  commandRegistry: CommandRegistry;
  toolRegistry: AtomPackRegistry;
  /** modelService.registry — accepts any object with a register method to avoid coupling to ModelService. */
  modelProviderRegistry: { register: (p: ModelProvider) => unknown };
  i18nService: I18nService;
  reconnectFileMcp: () => Promise<void>;
  channelService: { setRegistry: (reg: Awaited<ReturnType<typeof createChannelRegistry>>) => unknown };
  interactions: InteractionService;
  /** Re-bind and drain the running experience workers after the swap, so a reloaded pack's workers
   *  replace the previous ones instead of the sweep leaving the old set running. */
  syncExperienceWorkers?: () => Promise<void>;
};

/** Returns a `rediscoverAtomPacks` trigger. Concurrent calls are serialised — a second trigger
 *  chains onto the in-flight sweep rather than spawning a parallel import() run. */
export function createAtomPackRediscoverer(deps: AtomPackRediscovererDeps): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return (): Promise<void> => {
    const next = (inFlight ?? Promise.resolve()).then(async () => {
      const {
        paths,
        config,
        atomConflicts,
        atomDetailsByPack,
        activeAtomPacks,
        commandRegistry,
        toolRegistry,
        modelProviderRegistry,
        i18nService,
        reconnectFileMcp,
        channelService,
        interactions,
        syncExperienceWorkers
      } = deps;

      const pins = config.get().cfg.atomPins;

      // Construct phase: every registration lands in a throwaway candidate, so a pack that fails to
      // load (or a duplicate id, or a rejected bundle) aborts the sweep with the live registries
      // still holding the previous working set. Nothing below this point mutates live state.
      const candidateAtoms = new AtomPackRegistry();
      const candidateCommands: { atomName: string; command: unknown }[] = [];
      const candidateProviders: ModelProvider[] = [];
      const candidateConflicts: AtomConflict[] = [];
      const candidateDetails = new Map<string, AtomDescriptor[]>();
      const candidatePacks = new Map<string, ManifestAtomPack>();

      const builtin: BuiltinSinks = {
        onProvider: (p) => candidateProviders.push(p),
        onHook: (h) => candidateAtoms.registerHook(h),
        onWorkplaceExperienceApi: (api, atomPackId, permissions) =>
          candidateAtoms.registerWorkplaceExperienceApi(api, atomPackId, permissions),
        onExperienceWorker: (worker, atomPackId, permissions) =>
          candidateAtoms.registerExperienceWorker(worker, atomPackId, permissions),
        onWorkplaceExperience: (experience, atomPackId, permissions) =>
          candidateAtoms.registerWorkplaceExperience(experience, atomPackId, permissions),
        onRequestInteraction: (atomPackId, request) =>
          interactions.request({ kind: 'builtin', id: atomPackId, label: atomPackId }, request, { mode: 'background' })
      };
      const discovered: DiscoveredSinks = {
        onProvider: (p) => candidateProviders.push(p),
        channelPins: pins.channel,
        onCommand: (atomName, command) => candidateCommands.push({ atomName, command }),
        onCollision: (c) => candidateConflicts.push(c),
        onHook: (h) => candidateAtoms.registerHook(h),
        onWorkplaceExperienceApi: (api, atomPackId, permissions) =>
          candidateAtoms.registerWorkplaceExperienceApi(api, atomPackId, permissions),
        onExperienceWorker: (worker, atomPackId, permissions) =>
          candidateAtoms.registerExperienceWorker(worker, atomPackId, permissions),
        onWorkplaceExperience: (experience, atomPackId, permissions) =>
          candidateAtoms.registerWorkplaceExperience(experience, atomPackId, permissions),
        onAtoms: (packName, atoms) => candidateDetails.set(packName, atoms),
        onPackLoaded: (packId, atomPack) => candidatePacks.set(packId, atomPack),
        experienceReview: config.get().cfg.atomExperienceReview,
        onRequestInteraction: (packId, request) =>
          interactions.request({ kind: 'atom-pack', packId, atomId: 'pack' }, request, { mode: 'background' })
      };
      const reg = await createChannelRegistry(paths, { builtin, discovered });
      const [reBuiltinLocales, reInstalledLocales] = await Promise.all([
        loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName),
        loadInstalledLocalePacks(paths.packs, paths.locales, defaultLocaleName)
      ]);

      // Swap phase: the candidate is complete, so hand it over. Each step here either replaces a
      // whole set at once or replays already-validated input, and none of it can reject a pack.
      toolRegistry.adoptReloadableAtoms(candidateAtoms);
      commandRegistry.clearAtoms();
      for (const { atomName, command } of candidateCommands) commandRegistry.registerAtom(atomName, command);
      for (const provider of candidateProviders) modelProviderRegistry.register(provider);
      atomConflicts.length = 0;
      atomConflicts.push(...candidateConflicts);
      atomDetailsByPack.clear();
      for (const [packName, atoms] of candidateDetails) atomDetailsByPack.set(packName, atoms);
      commandRegistry.resolvePins(pins.command, (c) => atomConflicts.push(c));
      i18nService.setPacks([...reBuiltinLocales, ...reInstalledLocales], i18nService.locale);
      // Reconnect file/pack MCP servers so an installed/removed atoms/mcp server's tools re-register.
      await reconnectFileMcp();
      await channelService.setRegistry(reg);
      await syncExperienceWorkers?.();

      // Deactivate last: a dropped pack's own resources (timers, sockets, watchers) outlive its
      // registrations, and it must not be torn down until the replacement set is live and the
      // in-flight work it accepted has drained.
      const dropped = [...activeAtomPacks].filter(([packId]) => !candidatePacks.has(packId));
      for (const [packId] of dropped) activeAtomPacks.delete(packId);
      for (const [packId, atomPack] of candidatePacks) activeAtomPacks.set(packId, atomPack);
      await Promise.all(dropped.map(([packId, atomPack]) => deactivateAtomPack(packId, atomPack)));
    });
    inFlight = next;
    return next;
  };
}
