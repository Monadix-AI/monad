// Boot-phase helper: wraps the atom-pack rediscovery sweep (connectors / commands / hooks /
// providers / workspace experiences / locales / file-MCP) in a serialised, closure-free factory so main.ts can hand the
// returned function to both the API handler and the fs-watcher without re-capturing local variables.
// Tools are first-party only (wired once at startup) and never part of a rediscovery sweep.

import type { MonadConfig, MonadPaths } from '@monad/home';
import type { ModelProvider } from '@monad/sdk-atom';
import type { AtomConflict } from '@/atoms/resolve.ts';

import { loadAll } from '@monad/home';
import { defaultLocaleName, loadLocalePacksFromDir } from '@monad/i18n';
import { BUILTIN_LOCALES_DIR } from '@monad/i18n/locale-dir';

import { AtomPackRegistry } from '@/handlers/atom-pack/atom-pack-registry.ts';
import { CommandRegistry } from '@/handlers/commands/registry.ts';
import { I18nService, loadInstalledLocalePacks } from '@/services/i18n.ts';
import { type BuiltinSinks, createChannelRegistry, type DiscoveredSinks } from './channels.ts';

export type AtomPackRediscovererDeps = {
  paths: MonadPaths;
  /** cfg.atomPins — used as fallback when loadAll fails mid-write during a sweep. */
  fallbackAtomPins: MonadConfig['atomPins'];
  /** Mutated in place: cleared at the start of each sweep, then re-populated. */
  atomConflicts: AtomConflict[];
  commandRegistry: CommandRegistry;
  toolRegistry: AtomPackRegistry;
  /** modelService.registry — accepts any object with a register method to avoid coupling to ModelService. */
  modelProviderRegistry: { register: (p: ModelProvider) => unknown };
  i18nService: I18nService;
  reconnectFileMcp: () => Promise<void>;
  channelService: { setRegistry: (reg: Awaited<ReturnType<typeof createChannelRegistry>>) => unknown };
};

/** Returns a `rediscoverAtomPacks` trigger. Concurrent calls are serialised — a second trigger
 *  chains onto the in-flight sweep rather than spawning a parallel import() run. */
export function createAtomPackRediscoverer(deps: AtomPackRediscovererDeps): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  return (): Promise<void> => {
    const next = (inFlight ?? Promise.resolve()).then(async () => {
      const {
        paths,
        fallbackAtomPins,
        atomConflicts,
        commandRegistry,
        toolRegistry,
        modelProviderRegistry,
        i18nService,
        reconnectFileMcp,
        channelService
      } = deps;

      atomConflicts.length = 0;
      // Re-read pins so a just-saved pin (setAtomPin → onChanged) takes effect this sweep.
      const pins = (await loadAll(paths.config, paths.profile))?.atomPins ?? fallbackAtomPins;
      // Drop the previous sweep's third-party commands + all atom hooks so a removed/changed pack
      // doesn't leave stale entries; the sweep below re-adds the survivors.
      commandRegistry.clearAtoms();
      toolRegistry.clearHooks();
      toolRegistry.clearWorkspaceExperiences();

      const builtin: BuiltinSinks = {
        onProvider: (p) => modelProviderRegistry.register(p),
        onHook: (h) => toolRegistry.registerHook(h),
        onWorkspaceExperienceApi: (api, atomPackId) => toolRegistry.registerWorkspaceExperienceApi(api, atomPackId),
        onWorkspaceExperience: (experience, atomPackId) =>
          toolRegistry.registerWorkspaceExperience(experience, atomPackId)
      };
      const discovered: DiscoveredSinks = {
        onProvider: (p) => modelProviderRegistry.register(p),
        channelPins: pins.channel,
        connectorPins: pins.connector,
        onCommand: (atomName, cmd) => commandRegistry.registerAtom(atomName, cmd),
        onCollision: (c) => atomConflicts.push(c),
        onHook: (h) => toolRegistry.registerHook(h),
        onWorkspaceExperienceApi: (api, atomPackId) => toolRegistry.registerWorkspaceExperienceApi(api, atomPackId),
        onWorkspaceExperience: (experience, atomPackId) =>
          toolRegistry.registerWorkspaceExperience(experience, atomPackId)
      };
      const reg = await createChannelRegistry(paths, { builtin, discovered });
      commandRegistry.resolvePins(pins.command, (c) => atomConflicts.push(c));

      const [reBuiltinLocales, reInstalledLocales] = await Promise.all([
        loadLocalePacksFromDir(BUILTIN_LOCALES_DIR, defaultLocaleName),
        loadInstalledLocalePacks(paths.packs, paths.locales, defaultLocaleName)
      ]);
      i18nService.setPacks([...reBuiltinLocales, ...reInstalledLocales], i18nService.locale);
      // Reconnect file/pack MCP servers so an installed/removed atoms/mcp server's tools re-register.
      await reconnectFileMcp();
      await channelService.setRegistry(reg);
    });
    inFlight = next;
    return next;
  };
}
