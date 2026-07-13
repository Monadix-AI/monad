import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/home';
import type { Logger } from '@monad/logger';
import type { PrincipalId } from '@monad/protocol';
import type { ModelSubsystem } from '#/agent/model/lifecycle.ts';
import type { DaemonPreflight } from '#/application/preflight.ts';
import type { AtomDiscovery } from '#/atoms/lifecycle.ts';
import type { CapabilitiesRuntime } from '#/capabilities/lifecycle.ts';
import type { McpRuntime } from '#/capabilities/mcp/lifecycle.ts';
import type { SkillSubsystem } from '#/capabilities/skills/service.ts';
import type { HostInteractionService } from '#/interactions/service.ts';
import type { SandboxSetup } from '#/platform/sandbox/service.ts';
import type { RuntimeContextReader } from '#/runtime/types.ts';
import type { DataLayer } from '#/store/lifecycle.ts';

import { join } from 'node:path';
import { loadAll, loadAuth } from '@monad/home';

import { ConfigReloadTargets } from '#/config/reload-targets.ts';
import { createConfigReloader } from '#/config/reloader.ts';
import { createHomeConfigSource } from '#/config/source.ts';
import { WatchService } from '#/infra/watch-service.ts';
import { HostInteractionService as InteractionService } from '#/interactions/service.ts';
import { createDaemonModules, createDaemonRuntime } from '#/runtime/create.ts';
import { configureDeveloperLogTransport } from '#/services/developer-log.ts';
import { createDataLayer } from '#/store/lifecycle.ts';

export interface CoreRuntimeOutputs {
  dataLayer: DataLayer;
  sandbox: SandboxSetup;
  model: ModelSubsystem;
  capabilities: CapabilitiesRuntime;
  atoms: AtomDiscovery;
  skills: SkillSubsystem;
  mcp: McpRuntime;
}

export interface DaemonCore extends CoreRuntimeOutputs {
  paths: MonadPaths;
  flags: DaemonPreflight['flags'];
  cfg: MonadConfig;
  startupAuthValue: MonadAuth | null;
  startupAuth: MonadAuth | undefined;
  ownerPrincipalId: PrincipalId;
  monadVersion: string;
  watchService: WatchService;
  runtime: ReturnType<typeof createDaemonRuntime>;
  reloadTargets: ConfigReloadTargets;
  configReloader: ReturnType<typeof createConfigReloader>;
  interactions: HostInteractionService;
}

interface ProviderWatcherDeps {
  providersPath: string;
  watchService: Pick<WatchService, 'register'>;
  discoverProviders: (path: string) => Promise<{ errors: Array<{ file: string; error: string }> }>;
  warn: (message: string) => void;
}

export function registerProviderWatcher(deps: ProviderWatcherDeps): void {
  deps.watchService.register({
    name: 'providers',
    path: deps.providersPath,
    filter: (filename) => Boolean(filename?.endsWith('.js')),
    onChange: async () => {
      const result = await deps.discoverProviders(deps.providersPath);
      for (const error of result.errors) {
        deps.warn(`monad: provider atom "${error.file}" failed to reload: ${error.error}`);
      }
    }
  });
}

export function readCoreRuntimeOutputs(context: RuntimeContextReader): CoreRuntimeOutputs {
  return {
    dataLayer: context.get<DataLayer>('store'),
    sandbox: context.get<SandboxSetup>('platform.sandbox'),
    model: context.get<ModelSubsystem>('agent.model'),
    capabilities: context.get<CapabilitiesRuntime>('capabilities'),
    atoms: context.get<AtomDiscovery>('atoms'),
    skills: context.get<SkillSubsystem>('capabilities.skills'),
    mcp: context.get<McpRuntime>('capabilities.mcp')
  };
}

export async function createCoreRuntime(preflight: DaemonPreflight, logger: Logger): Promise<DaemonCore> {
  const { paths, flags } = preflight;
  const dataLayer = await createDataLayer({ paths, devMode: flags.devMode || flags.devSilent });
  const [cfg, startupAuthValue] = await Promise.all([loadAll(paths.config, paths.profile), loadAuth(paths.auth)]);
  if (!cfg) throw new Error('monad: config.json missing after repair — aborting');
  const startupAuth = startupAuthValue ?? undefined;
  configureDeveloperLogTransport(paths, cfg.developerMode === true);
  const ownerPrincipalId = cfg.principal.id as PrincipalId;
  const monadVersion = await Bun.file(join(import.meta.dir, '..', '..', 'package.json'))
    .json()
    .then((value: { version?: string }) => value.version ?? '0.0.0')
    .catch(() => '0.0.0');
  const watchService = new WatchService({ log: (level, message) => logger[level](message) });
  process.on('exit', () => watchService.closeAll());
  const reloadTargets = new ConfigReloadTargets();
  const interactions = new InteractionService();
  let runtime: ReturnType<typeof createDaemonRuntime>;
  const configReloader = createConfigReloader(async () => {
    await runtime.config.refreshNow();
  });
  const configSource = createHomeConfigSource(paths, {
    watch: (onChange) => {
      watchService.register({
        name: 'settings',
        path: paths.home,
        filter: (filename) =>
          filename === 'config.json' ||
          filename === 'profile.json' ||
          filename === 'sandbox.json' ||
          filename === 'auth.json',
        onChange
      });
      return () => {};
    }
  });
  const initial = { cfg, auth: startupAuthValue };
  runtime = createDaemonRuntime({
    initial,
    modules: createDaemonModules({
      initial,
      paths,
      devMode: flags.devMode || flags.devSilent,
      useMock: flags.useMock,
      monadVersion,
      watcher: watchService,
      logger,
      interactions,
      startStore: async () => dataLayer
    }),
    source: configSource,
    watchOnStart: false,
    afterReload: (snapshot) => reloadTargets.apply(snapshot)
  });
  await runtime.start();
  const outputs = readCoreRuntimeOutputs(runtime.kernel.context);
  if (outputs.dataLayer !== dataLayer) throw new Error('monad: runtime store output mismatch');
  registerProviderWatcher({
    providersPath: paths.providers,
    watchService,
    discoverProviders: (path) => outputs.model.modelService.discoverProviders(path),
    warn: (message) => logger.warn(message)
  });
  return {
    ...outputs,
    paths,
    flags,
    cfg,
    startupAuthValue,
    startupAuth,
    ownerPrincipalId,
    monadVersion,
    watchService,
    runtime,
    reloadTargets,
    configReloader,
    interactions
  };
}
