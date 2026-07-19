import type { MeshAgentConfig } from '@monad/environment';
import type { MeshAgentPresetView, MeshAgentProvider, MeshAgentView } from '@monad/protocol';
import type { BinProbes } from '#/infra/resolve-binary.ts';
import type { MeshAgentProbeResult, MeshAgentProbeRunner } from '#/services/mesh-agent/probe-batch.ts';
import type {
  MeshAgentArgumentSupport,
  MeshAgentLaunchSpec,
  MeshAgentModelOption,
  MeshAgentProviderAdapter
} from '#/services/mesh-agent/types.ts';

import { spawnSync } from 'node:child_process';

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
  return {
    name: agent.name,
    provider: agent.provider,
    productIcon: adapter.productIcon,
    command: agent.command,
    args: agent.args,
    env: agent.env,
    enabled: agent.enabled,
    allowAutopilot: agent.allowAutopilot,
    approvalOwnership: 'provider-owned',
    projectTemplates: agent.projectTemplates,
    adapterSettings: agent.adapterSettings
  };
}

export function resolveMeshAgentModelOptions(
  agent: MeshAgentView,
  probes: BinProbes = defaultBinProbes
): Pick<MeshAgentView, 'modelOptions' | 'modelOptionDisplayNames'> {
  const adapter = adapterFor(agent.provider);
  const fallback = adapter.listSupportedModels(agent);
  const probe = adapter.modelOptions?.(agent);
  if (!probe) return { modelOptions: fallback };
  let launch: MeshAgentLaunchSpec;
  try {
    launch = resolveMeshAgentLaunchCommand(adapter, probe.launch, probes);
  } catch {
    return { modelOptions: fallback };
  }
  const result = spawnSync(launch.argv[0] as string, launch.argv.slice(1), {
    cwd: launch.cwd,
    env: { ...process.env, ...(launch.env ?? {}) },
    encoding: 'utf8',
    timeout: 2000
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const parsed = probe.parse(output, typeof result.status === 'number' ? result.status : null);
  if (parsed.length === 0) return { modelOptions: fallback };
  return modelOptionsFromProbe(parsed);
}

function modelOptionsFromProbe(
  options: MeshAgentModelOption[]
): Pick<MeshAgentView, 'modelOptions' | 'modelOptionDisplayNames'> {
  const modelOptions: string[] = [];
  const modelOptionDisplayNames: Record<string, string> = {};
  const seen = new Set<string>();
  for (const option of options) {
    if (!option.value || seen.has(option.value)) continue;
    seen.add(option.value);
    modelOptions.push(option.value);
    if (option.displayName) modelOptionDisplayNames[option.value] = option.displayName;
  }
  return {
    modelOptions,
    ...(Object.keys(modelOptionDisplayNames).length > 0 ? { modelOptionDisplayNames } : {})
  };
}

function probeMeshAgentArgumentSupport(
  agent: MeshAgentView,
  probes: BinProbes = defaultBinProbes
): MeshAgentArgumentSupport | undefined {
  const adapter = adapterFor(agent.provider);
  const probe = adapter.argumentSupport?.(agent);
  if (!probe) return undefined;
  let launch: MeshAgentLaunchSpec;
  try {
    launch = resolveMeshAgentLaunchCommand(adapter, probe.launch, probes);
  } catch {
    return undefined;
  }
  const result = spawnSync(launch.argv[0] as string, launch.argv.slice(1), {
    cwd: launch.cwd,
    env: { ...process.env, ...(launch.env ?? {}) },
    encoding: 'utf8',
    timeout: 2000
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return probe.parse(output, typeof result.status === 'number' ? result.status : null);
}

export function listMeshAgentReasoningEfforts(agent: MeshAgentView, probes: BinProbes = defaultBinProbes): string[] {
  const support = probeMeshAgentArgumentSupport(agent, probes);
  return support?.reasoningEfforts ?? [];
}

/** Reasoning efforts split by model slug (the union is `listMeshAgentReasoningEfforts`). Shares
 *  the single argument-support probe, so it adds no extra provider spawn. */
export function listMeshAgentReasoningEffortsByModel(
  agent: MeshAgentView,
  probes: BinProbes = defaultBinProbes
): Record<string, string[]> | undefined {
  return probeMeshAgentArgumentSupport(agent, probes)?.reasoningEffortsByModel;
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
    allowAutopilot: false,
    approvalOwnership: 'provider-owned',
    settings: preset.settings
  };
}

type ResolvedPresetProbe<T> = {
  launch: MeshAgentLaunchSpec;
  parse(output: string, exitCode: number | null): T;
};

type PlannedPreset = {
  adapter: MeshAgentProviderAdapter;
  agentView: MeshAgentView;
  preset: MeshAgentPresetView;
  supportProbe?: ResolvedPresetProbe<MeshAgentArgumentSupport>;
  modelProbe?: ResolvedPresetProbe<MeshAgentModelOption[]>;
};

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

function planPreset(adapter: MeshAgentProviderAdapter, probes: BinProbes): PlannedPreset {
  const detected = adapter.detect(probes);
  const preset = {
    ...detected,
    settings: detected.settings ?? adapter.settings?.(presetAgentView(detected))
  };
  const agentView = presetAgentView(preset);
  return {
    adapter,
    agentView,
    preset,
    supportProbe: resolvePresetProbe(adapter, adapter.argumentSupport?.(agentView), probes),
    modelProbe: resolvePresetProbe(adapter, adapter.modelOptions?.(agentView), probes)
  };
}

export async function listMeshAgentPresets(
  probes: BinProbes = defaultBinProbes,
  runner: MeshAgentProbeRunner = runMeshAgentProbe
): Promise<MeshAgentPresetView[]> {
  const planned = [...ADAPTERS.values()].map((adapter) => planPreset(adapter, probes));
  const results = await runMeshAgentProbeBatch(
    planned.flatMap(({ supportProbe, modelProbe }) =>
      [supportProbe?.launch, modelProbe?.launch].filter((launch): launch is MeshAgentLaunchSpec => launch !== undefined)
    ),
    runner
  );
  return planned.map(({ adapter, agentView, preset, supportProbe, modelProbe }) => {
    const support = parsePresetProbe(supportProbe, results);
    const models = parsePresetProbe(modelProbe, results);
    const modelOptions =
      models && models.length > 0
        ? modelOptionsFromProbe(models)
        : { modelOptions: adapter.listSupportedModels(agentView) };
    return {
      ...preset,
      ...modelOptions,
      reasoningEfforts: support?.reasoningEfforts ?? [],
      reasoningEffortsByModel: support?.reasoningEffortsByModel
    };
  });
}
