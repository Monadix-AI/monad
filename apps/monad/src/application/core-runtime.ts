import type { MonadAuth, MonadConfig, MonadPaths } from '@monad/environment';
import type { Logger } from '@monad/logger';
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

import { ConfigManager } from '#/config/manager.ts';
import { ConfigReloadTargets } from '#/config/reload-targets.ts';
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
  monadVersion: string;
  watchService: WatchService;
  runtime: ReturnType<typeof createDaemonRuntime>;
  reloadTargets: ConfigReloadTargets;
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
  const watchService = new WatchService({ log: (level, message) => logger[level](message) });
  process.on('exit', () => watchService.closeAll());
  const reloadTargets = new ConfigReloadTargets();
  const interactions = new InteractionService();
  const configSource = createHomeConfigSource(paths, {
    watch: (onChange) => {
      watchService.register({
        name: 'settings',
        path: paths.home,
        filter: (filename) =>
          filename === 'config.json' ||
          filename === 'agents.json' ||
          filename === 'mesh.json' ||
          filename === 'auth.json',
        onChange
      });
      return () => {};
    }
  });
  const initial = await ConfigManager.load(configSource);
  const { cfg, auth: startupAuthValue } = initial;
  const startupAuth = startupAuthValue ?? undefined;
  configureDeveloperLogTransport(paths, cfg.developerMode === true);
  const monadVersion = await Bun.file(join(import.meta.dir, '..', '..', 'package.json'))
    .json()
    .then((value: { version?: string }) => value.version ?? '0.0.0')
    .catch(() => '0.0.0');
  let runtime: ReturnType<typeof createDaemonRuntime>;
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
      config: () => runtime.config,
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
    monadVersion,
    watchService,
    runtime,
    reloadTargets,
    interactions
  };
}
