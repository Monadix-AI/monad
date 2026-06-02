import type { MeshAgentConfig } from '@monad/environment';
import type { MeshAgentPresetView, MeshAgentProvider, MeshAgentView } from '@monad/protocol';
import type { BinProbes } from '#/infra/resolve-binary.ts';
import type { MeshAgentProbeResult, MeshAgentProbeRunner } from '#/services/mesh-agent/probe-batch.ts';
import type {
  MeshAgentArgumentSupport,
  MeshAgentLaunchSpec,
  MeshAgentModelOption,
  MeshAgentModelOptionsProbe,
  MeshAgentProviderAdapter
} from '#/services/mesh-agent/types.ts';

import { defaultBinProbes } from '#/infra/resolve-binary.ts';
import { meshAgentProbeKey, runMeshAgentProbe, runMeshAgentProbeBatch } from '#/services/mesh-agent/probe-batch.ts';

export type { MeshAgentLaunchSpec, MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

// Populated at daemon boot when @monad/atoms registers its `agent-adapter` atoms through the gated
// atom-pack path (ManifestAtomPackHost.registerAgentAdapter → registerAgentAdapterImpl). Nothing
// first-party bypasses the gate — the "core is all atoms" invariant. Insertion order is the pack's
// declaration order, which listMeshAgentPresets preserves.
const ADAPTERS = new Map<MeshAgentProvider, MeshAgentProviderAdapter>();

export function registerAgentAdapterImpl(adapter: MeshAgentProviderAdapter): void {
  ADAPTERS.set(adapter.provider, adapter);
}

/** Reverses a registerAgentAdapterImpl call. Production never needs this (adapters live for the
 *  daemon's lifetime); it exists so tests that register a throwaway provider can clean up afterward
 *  instead of leaking it into every other test sharing this module-level registry. */
export function unregisterAgentAdapterImpl(provider: MeshAgentProvider): void {
  ADAPTERS.delete(provider);
}

function adapterFor(provider: MeshAgentProvider): MeshAgentProviderAdapter {
  const adapter = ADAPTERS.get(provider);
  if (!adapter) throw new Error(`no agent-adapter atom registered for provider "${provider}"`);
  return adapter;
}

function meshAgentExecutionCapabilities(adapter: MeshAgentProviderAdapter): {
  autopilot: boolean;
  fastMode: boolean;
} {
  return {
    autopilot: adapter.executionCapabilities?.autopilot === true,
    fastMode: adapter.executionCapabilities?.fastMode === true
  };
}

export function meshAgentSettingsForAdapter(
  adapter: MeshAgentProviderAdapter,
  agent?: MeshAgentView
): NonNullable<MeshAgentView['settings']> | undefined {
  return filterMeshAgentSettings(adapter, adapter.settings?.(agent));
}

function filterMeshAgentSettings(
  adapter: MeshAgentProviderAdapter,
  settings: MeshAgentView['settings']
): MeshAgentView['settings'] {
  if (adapter.executionCapabilities?.autopilot === true) return settings;
  return settings?.filter((setting) => setting.key !== 'allowAutopilot');
}

function assertSafeArgs(agent: MeshAgentView, adapter: MeshAgentProviderAdapter): void {
  if (agent.allowAutopilot) return;
  const arg = adapter.unsafeArgument?.(agent.args ?? []);
  if (arg) throw new Error(`dangerous MeshAgent arg "${arg}" requires allowAutopilot`);
}

function assertCommandShape(agent: MeshAgentView): void {
  if (!agent.command.trim()) throw new Error(`MeshAgent "${agent.name}": command must not be blank`);
  if (/\s/.test(agent.command)) {
    throw new Error(`MeshAgent "${agent.name}": command must be a binary path or name; use args for flags`);
  }
}

export function resolveMeshAgentLaunchCommand(
  adapter: MeshAgentProviderAdapter,
  launch: MeshAgentLaunchSpec,
  probes: BinProbes = defaultBinProbes
): MeshAgentLaunchSpec {
  const command = launch.argv[0];
  if (!command) throw new Error(`MeshAgent provider "${adapter.provider}": launch argv must include a command`);
  const resolvedCommand = resolveProviderExecutable(adapter, command, probes);
  if (resolvedCommand === command) return launch;
  return { ...launch, argv: [resolvedCommand, ...launch.argv.slice(1)] };
}

function resolveProviderExecutable(
  adapter: MeshAgentProviderAdapter,
  command: string,
  probes: BinProbes = defaultBinProbes
): string {
  const resolved = adapter.resolveCommand?.(command, probes) ?? probes.which(command);
  if (!resolved) {
    throw new Error(`Executable not found in $PATH or known ${adapter.provider} install locations: "${command}"`);
  }
  return resolved;
}

export function resolveMeshAgentExecutable(
  agent: MeshAgentView,
  adapter: MeshAgentProviderAdapter,
  probes: BinProbes = defaultBinProbes
): string {
  assertSafeArgs(agent, adapter);
  assertCommandShape(agent);
  return resolveProviderExecutable(adapter, agent.command, probes);
}

export function buildMeshAgentAuthLaunch(agent: MeshAgentView): MeshAgentLaunchSpec {
  const adapter = adapterFor(agent.provider);
  assertSafeArgs(agent, adapter);
  assertCommandShape(agent);
  return adapter.buildAuthLaunch(agent);
}

export function meshAgentConfigToView(agent: MeshAgentConfig): MeshAgentView {
  const adapter = adapterFor(agent.provider);
  const executionCapabilities = meshAgentExecutionCapabilities(adapter);
  const providerCapabilities = adapter.detect().capabilities;
  return {
    name: agent.name,
    displayName: agent.displayName,
    provider: agent.provider,
    productIcon: adapter.productIcon,
    command: agent.command,
    args: agent.args,
    env: agent.env,
    enabled: agent.enabled,
    allowAutopilot: executionCapabilities.autopilot && agent.allowAutopilot === true,
    approvalOwnership: 'provider-owned',
    capabilities: {
      auth: providerCapabilities?.auth ?? 'none',
      events: providerCapabilities?.events ?? 'none',
      resume: providerCapabilities?.resume ?? 'pty',
      approval: providerCapabilities?.approval ?? 'provider-owned',
      ...(providerCapabilities?.settingsImport !== undefined
        ? { settingsImport: providerCapabilities.settingsImport }
        : {}),
      ...(providerCapabilities?.approvalProxy !== undefined
        ? { approvalProxy: providerCapabilities.approvalProxy }
        : {}),
      ...executionCapabilities
    },
    adapterSettings: agent.adapterSettings,
    discovery: agent.discovery
  };
}

function modelOptionsFromProbe(
  options: MeshAgentModelOption[]
): Pick<MeshAgentView, 'modelOptions' | 'modelOptionDisplayNames' | 'speedsByModel'> {
  const modelOptions: string[] = [];
  const modelOptionDisplayNames: Record<string, string> = {};
  const speedsByModel: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const option of options) {
    if (!option.value || seen.has(option.value)) continue;
    seen.add(option.value);
    modelOptions.push(option.value);
    if (option.displayName) modelOptionDisplayNames[option.value] = option.displayName;
    if (option.speeds && option.speeds.length > 0) speedsByModel[option.value] = option.speeds;
  }
  return {
    modelOptions,
    ...(Object.keys(modelOptionDisplayNames).length > 0 ? { modelOptionDisplayNames } : {}),
    ...(Object.keys(speedsByModel).length > 0 ? { speedsByModel } : {})
  };
}

export function getMeshAgentProviderAdapter(provider: MeshAgentProvider): MeshAgentProviderAdapter {
  return adapterFor(provider);
}

/** Non-throwing registry lookup for display/notice code that must degrade gracefully when a provider
 *  has no registered adapter (never throws, unlike getMeshAgentProviderAdapter). */
export function findMeshAgentProviderAdapter(provider: MeshAgentProvider): MeshAgentProviderAdapter | undefined {
  return ADAPTERS.get(provider);
}

/** All registered agent adapters, in pack-declaration order. Lets cross-cutting features (e.g. the ACP
 *  delegation invite list) derive from the single adapter registry instead of a parallel static list. */
export function listMeshAgentProviderAdapters(): MeshAgentProviderAdapter[] {
  return [...ADAPTERS.values()];
}

function presetAgentView(preset: MeshAgentPresetView): MeshAgentView {
  return {
    name: preset.id,
    provider: preset.provider,
    productIcon: preset.productIcon,
    command: preset.command,
    args: preset.args,
    enabled: preset.installed,
    allowAutopilot: preset.capabilities?.autopilot === true,
    approvalOwnership: 'provider-owned',
    settings: preset.settings
  };
}

type ResolvedPresetProbe<T> = {
  launch: MeshAgentLaunchSpec;
  parse(output: string, exitCode: number | null): T;
};

type MeshAgentCapabilities = Pick<
  MeshAgentView,
  'modelOptions' | 'modelOptionDisplayNames' | 'speedsByModel' | 'reasoningEfforts' | 'reasoningEffortsByModel'
>;

type PlannedCapabilities = {
  adapter: MeshAgentProviderAdapter;
  agentView: MeshAgentView;
  supportProbe?: ResolvedPresetProbe<MeshAgentArgumentSupport>;
  modelProbe?: MeshAgentModelOptionsProbe;
};

type PlannedPreset = {
  adapter: MeshAgentProviderAdapter;
  agentView: MeshAgentView;
  preset: MeshAgentPresetView;
  supportProbe?: ResolvedPresetProbe<MeshAgentArgumentSupport>;
  modelProbe?: MeshAgentModelOptionsProbe;
};

function resolveModelProbe(
  adapter: MeshAgentProviderAdapter,
  probe: MeshAgentModelOptionsProbe | undefined,
  probes: BinProbes
): MeshAgentModelOptionsProbe | undefined {
  if (!probe || 'resolve' in probe) return probe;
  return resolvePresetProbe(adapter, probe, probes);
}

async function modelsFromProbe(
  probe: MeshAgentModelOptionsProbe | undefined,
  results: ReadonlyMap<string, MeshAgentProbeResult | null>
): Promise<MeshAgentModelOption[] | undefined> {
  if (!probe) return undefined;
  try {
    return 'resolve' in probe ? await probe.resolve() : parsePresetProbe(probe, results);
  } catch {
    return undefined;
  }
}

function resolvePresetProbe<T>(
  adapter: MeshAgentProviderAdapter,
  probe: ResolvedPresetProbe<T> | undefined,
  probes: BinProbes
): ResolvedPresetProbe<T> | undefined {
  if (!probe) return undefined;
  try {
    return { ...probe, launch: resolveMeshAgentLaunchCommand(adapter, probe.launch, probes) };
  } catch {
    return undefined;
  }
}

function parsePresetProbe<T>(
  probe: ResolvedPresetProbe<T> | undefined,
  results: ReadonlyMap<string, MeshAgentProbeResult | null>
): T | undefined {
  if (!probe) return undefined;
  const result = results.get(meshAgentProbeKey(probe.launch));
  if (result?.exitCode !== 0) return undefined;
  try {
    return probe.parse(`${result.stdout}\n${result.stderr}`, result.exitCode);
  } catch {
    return undefined;
  }
}

function planCapabilities(agentView: MeshAgentView, probes: BinProbes): PlannedCapabilities {
  const adapter = adapterFor(agentView.provider);
  return {
    adapter,
    agentView,
    supportProbe: resolvePresetProbe(adapter, adapter.argumentSupport?.(agentView), probes),
    modelProbe: resolveModelProbe(adapter, adapter.modelOptions?.(agentView), probes)
  };
}

function capabilitiesFromPlan(
  { adapter, agentView, supportProbe, modelProbe }: PlannedCapabilities,
  results: ReadonlyMap<string, MeshAgentProbeResult | null>,
  models: MeshAgentModelOption[] | undefined
): MeshAgentCapabilities {
  const support = parsePresetProbe(supportProbe, results);
  const modelOptions =
    models !== undefined
      ? modelOptionsFromProbe(models)
      : { modelOptions: modelProbe ? [] : adapter.listSupportedModels(agentView) };
  return {
    ...modelOptions,
    reasoningEfforts: support?.reasoningEfforts ?? [],
    reasoningEffortsByModel: support?.reasoningEffortsByModel
  };
}

export async function resolveMeshAgentCapabilities(
  agents: readonly MeshAgentView[],
  runner: MeshAgentProbeRunner = runMeshAgentProbe,
  probes: BinProbes = defaultBinProbes
): Promise<MeshAgentCapabilities[]> {
  const planned = agents.map((agent) => planCapabilities(agent, probes));
  const results = await runMeshAgentProbeBatch(
    planned.flatMap(({ supportProbe, modelProbe }) =>
      [supportProbe?.launch, modelProbe && 'launch' in modelProbe ? modelProbe.launch : undefined].filter(
        (launch): launch is MeshAgentLaunchSpec => launch !== undefined
      )
    ),
    runner
  );
  return Promise.all(
    planned.map(async (plan) => capabilitiesFromPlan(plan, results, await modelsFromProbe(plan.modelProbe, results)))
  );
}

function planPreset(adapter: MeshAgentProviderAdapter, probes: BinProbes): PlannedPreset {
  const detected = adapter.detect(probes);
  const executionCapabilities = meshAgentExecutionCapabilities(adapter);
  const detectedSettings = detected.settings ?? adapter.settings?.(presetAgentView(detected));
  const preset = {
    ...detected,
    icon: adapter.icon,
    capabilities: {
      auth: detected.capabilities?.auth ?? 'none',
      events: detected.capabilities?.events ?? 'none',
      resume: detected.capabilities?.resume ?? 'pty',
      approval: detected.capabilities?.approval ?? 'provider-owned',
      ...(detected.capabilities?.settingsImport !== undefined
        ? { settingsImport: detected.capabilities.settingsImport }
        : {}),
      ...(detected.capabilities?.approvalProxy !== undefined
        ? { approvalProxy: detected.capabilities.approvalProxy }
        : {}),
      ...executionCapabilities
    },
    settings: filterMeshAgentSettings(adapter, detectedSettings)
  };
  const agentView = presetAgentView(preset);
  return {
    adapter,
    agentView,
    preset,
    supportProbe: resolvePresetProbe(adapter, adapter.argumentSupport?.(agentView), probes),
    modelProbe: resolveModelProbe(adapter, adapter.modelOptions?.(agentView), probes)
  };
}

export function listMeshAgentPresetFallbacks(
  probes: BinProbes = defaultBinProbes,
  providers: readonly MeshAgentProvider[] = [...ADAPTERS.keys()]
): MeshAgentPresetView[] {
  return providers.flatMap((provider) => {
    const adapter = ADAPTERS.get(provider);
    if (!adapter) return [];
    const { preset } = planPreset(adapter, probes);
    return [
      {
        ...preset,
        modelOptions: preset.modelOptions ?? adapter.listSupportedModels(presetAgentView(preset)),
        reasoningEfforts: []
      }
    ];
  });
}

export async function listMeshAgentPresets(
  probes: BinProbes = defaultBinProbes,
  runner: MeshAgentProbeRunner = runMeshAgentProbe,
  providers: readonly MeshAgentProvider[] = [...ADAPTERS.keys()]
): Promise<MeshAgentPresetView[]> {
  const planned = providers.flatMap((provider) => {
    const adapter = ADAPTERS.get(provider);
    return adapter ? [planPreset(adapter, probes)] : [];
  });
  const results = await runMeshAgentProbeBatch(
    planned.flatMap(({ supportProbe, modelProbe }) =>
      [supportProbe?.launch, modelProbe && 'launch' in modelProbe ? modelProbe.launch : undefined].filter(
        (launch): launch is MeshAgentLaunchSpec => launch !== undefined
      )
    ),
    runner
  );
  return Promise.all(
    planned.map(async ({ adapter, agentView, preset, supportProbe, modelProbe }) => {
      const support = parsePresetProbe(supportProbe, results);
      const models = await modelsFromProbe(modelProbe, results);
      const modelOptions =
        models !== undefined
          ? modelOptionsFromProbe(models)
          : { modelOptions: modelProbe ? [] : adapter.listSupportedModels(agentView) };
      return {
        ...preset,
        ...modelOptions,
        reasoningEfforts: support?.reasoningEfforts ?? [],
        reasoningEffortsByModel: support?.reasoningEffortsByModel
      };
    })
  );
}
