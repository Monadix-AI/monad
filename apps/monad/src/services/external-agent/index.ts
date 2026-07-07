import type { ExternalAgentPresetView, ExternalAgentProvider, ExternalAgentView } from '@monad/protocol';
import type { BinProbes } from '@/infra/resolve-binary.ts';
import type {
  BuildExternalAgentLaunchOptions,
  ExternalAgentArgumentSupport,
  ExternalAgentArgumentSupportProbe,
  ExternalAgentLaunchSpec,
  ExternalAgentProviderAdapter
} from '@/services/external-agent/types.ts';

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { defaultBinProbes } from '@/infra/resolve-binary.ts';

export type { ExternalAgentLaunchSpec, ExternalAgentProviderAdapter } from '@/services/external-agent/types.ts';

const DANGEROUS_ARGS = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--yolo'
]);

function isDangerousArg(arg: string, next: string | undefined): boolean {
  if (DANGEROUS_ARGS.has(arg)) return true;
  if (arg === '--approval-mode' && next === 'yolo') return true;
  return arg === '--approval-mode=yolo';
}

// Populated at daemon boot when @monad/atoms registers its `agent-adapter` atoms through the gated
// atom-pack path (ManifestAtomPackHost.registerAgentAdapter → registerAgentAdapterImpl). Nothing
// first-party bypasses the gate — the "core is all atoms" invariant. Insertion order is the pack's
// declaration order, which listExternalAgentPresets preserves.
const ADAPTERS = new Map<ExternalAgentProvider, ExternalAgentProviderAdapter>();

export function registerAgentAdapterImpl(adapter: ExternalAgentProviderAdapter): void {
  ADAPTERS.set(adapter.provider, adapter);
}

/** Reverses a registerAgentAdapterImpl call. Production never needs this (adapters live for the
 *  daemon's lifetime); it exists so tests that register a throwaway provider can clean up afterward
 *  instead of leaking it into every other test sharing this module-level registry. */
export function unregisterAgentAdapterImpl(provider: ExternalAgentProvider): void {
  ADAPTERS.delete(provider);
}

function adapterFor(provider: ExternalAgentProvider): ExternalAgentProviderAdapter {
  const adapter = ADAPTERS.get(provider);
  if (!adapter) throw new Error(`no agent-adapter atom registered for provider "${provider}"`);
  return adapter;
}

function assertSafeArgs(agent: ExternalAgentView): void {
  if (agent.allowAutopilot) return;
  const args = agent.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (isDangerousArg(arg, args[index + 1])) {
      throw new Error(`dangerous external agent arg "${arg}" requires allowAutopilot`);
    }
  }
}

function assertCommandShape(agent: ExternalAgentView): void {
  if (!agent.command.trim()) throw new Error(`external agent "${agent.name}": command must not be blank`);
  if (/\s/.test(agent.command)) {
    throw new Error(`external agent "${agent.name}": command must be a binary path or name; use args for flags`);
  }
}

export function buildExternalAgentLaunch(
  agent: ExternalAgentView,
  opts: BuildExternalAgentLaunchOptions
): ExternalAgentLaunchSpec {
  assertSafeArgs(agent);
  if (!isAbsolute(opts.workingPath)) throw new Error('workingPath must be absolute');
  assertCommandShape(agent);
  return adapterFor(agent.provider).buildLaunch(agent, opts);
}

export function resolveExternalAgentLaunchCommand(
  adapter: ExternalAgentProviderAdapter,
  launch: ExternalAgentLaunchSpec,
  probes: BinProbes = defaultBinProbes
): ExternalAgentLaunchSpec {
  const command = launch.argv[0];
  if (!command) throw new Error(`external agent provider "${adapter.provider}": launch argv must include a command`);
  const resolvedCommand = adapter.resolveCommand?.(command, probes) ?? probes.which(command);
  if (!resolvedCommand) {
    throw new Error(`Executable not found in $PATH or known ${adapter.provider} install locations: "${command}"`);
  }
  if (resolvedCommand === command) return launch;
  return { ...launch, argv: [resolvedCommand, ...launch.argv.slice(1)] };
}

export function buildExternalAgentAuthLaunch(agent: ExternalAgentView): ExternalAgentLaunchSpec {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return adapterFor(agent.provider).buildAuthLaunch(agent);
}

export function buildExternalAgentAuthStatusLaunch(agent: ExternalAgentView): ExternalAgentLaunchSpec {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return adapterFor(agent.provider).authStatus(agent).launch;
}

export function buildExternalAgentArgumentSupportProbe(
  agent: ExternalAgentView
): ExternalAgentArgumentSupportProbe | undefined {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return adapterFor(agent.provider).argumentSupport?.(agent);
}

export function listExternalAgentModelOptions(
  agent: ExternalAgentView,
  probes: BinProbes = defaultBinProbes
): string[] {
  const adapter = adapterFor(agent.provider);
  if (agent.modelOptions?.length) return agent.modelOptions;
  const fallback = adapter.listSupportedModels(agent);
  const probe = adapter.modelOptions?.(agent);
  if (!probe) return fallback;
  let launch: ExternalAgentLaunchSpec;
  try {
    launch = resolveExternalAgentLaunchCommand(adapter, probe.launch, probes);
  } catch {
    return fallback;
  }
  const result = spawnSync(launch.argv[0] as string, launch.argv.slice(1), {
    cwd: launch.cwd,
    env: { ...process.env, ...(launch.env ?? {}) },
    encoding: 'utf8',
    timeout: 2000
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const parsed = probe.parse(output, typeof result.status === 'number' ? result.status : null);
  return parsed.length > 0 ? parsed : fallback;
}

function probeExternalAgentArgumentSupport(
  agent: ExternalAgentView,
  probes: BinProbes = defaultBinProbes
): ExternalAgentArgumentSupport | undefined {
  const adapter = adapterFor(agent.provider);
  const probe = adapter.argumentSupport?.(agent);
  if (!probe) return undefined;
  let launch: ExternalAgentLaunchSpec;
  try {
    launch = resolveExternalAgentLaunchCommand(adapter, probe.launch, probes);
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

export function listExternalAgentReasoningEfforts(
  agent: ExternalAgentView,
  probes: BinProbes = defaultBinProbes
): string[] {
  const support = probeExternalAgentArgumentSupport(agent, probes);
  return support?.reasoningEfforts ?? [];
}

/** Reasoning efforts split by model slug (the union is `listExternalAgentReasoningEfforts`). Shares
 *  the single argument-support probe, so it adds no extra provider spawn. */
export function listExternalAgentReasoningEffortsByModel(
  agent: ExternalAgentView,
  probes: BinProbes = defaultBinProbes
): Record<string, string[]> | undefined {
  return probeExternalAgentArgumentSupport(agent, probes)?.reasoningEffortsByModel;
}

export function getExternalAgentProviderAdapter(provider: ExternalAgentProvider): ExternalAgentProviderAdapter {
  return adapterFor(provider);
}

/** Non-throwing registry lookup for display/notice code that must degrade gracefully when a provider
 *  has no registered adapter (never throws, unlike getExternalAgentProviderAdapter). */
export function findExternalAgentProviderAdapter(
  provider: ExternalAgentProvider
): ExternalAgentProviderAdapter | undefined {
  return ADAPTERS.get(provider);
}

/** All registered agent adapters, in pack-declaration order. Lets cross-cutting features (e.g. the ACP
 *  delegation invite list) derive from the single adapter registry instead of a parallel static list. */
export function listExternalAgentProviderAdapters(): ExternalAgentProviderAdapter[] {
  return [...ADAPTERS.values()];
}

function presetAgentView(preset: ExternalAgentPresetView): ExternalAgentView {
  return {
    name: preset.id,
    provider: preset.provider,
    productIcon: preset.productIcon,
    command: preset.command,
    args: preset.args,
    enabled: preset.installed,
    defaultLaunchMode: preset.defaultLaunchMode,
    allowAutopilot: false,
    approvalOwnership: 'provider-owned',
    settings: preset.settings
  };
}

export function listExternalAgentPresets(probes: BinProbes = defaultBinProbes): ExternalAgentPresetView[] {
  return [...ADAPTERS.values()]
    .map((adapter) => {
      const preset = adapter.detect(probes);
      return {
        ...preset,
        settings: preset.settings ?? adapter.settings?.(presetAgentView(preset))
      };
    })
    .map((preset) => {
      const agentView = presetAgentView(preset);
      // reasoningEfforts/reasoningEffortsByModel share one argument-support probe (both derive from
      // the same `<cli> --help`-style spawn) — probe once here instead of letting each of
      // listExternalAgentReasoningEfforts/listExternalAgentReasoningEffortsByModel call it
      // independently, which spawned the provider CLI twice per adapter for one settings-page load.
      const support = probeExternalAgentArgumentSupport(agentView, probes);
      return {
        ...preset,
        modelOptions: listExternalAgentModelOptions(agentView, probes),
        reasoningEfforts: support?.reasoningEfforts ?? [],
        reasoningEffortsByModel: support?.reasoningEffortsByModel
      };
    });
}
