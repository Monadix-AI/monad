import type { NativeCliAgentPresetView, NativeCliAgentView, NativeCliProvider } from '@monad/protocol';
import type { BinProbes } from '@/infra/resolve-binary.ts';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliArgumentSupport,
  NativeCliArgumentSupportProbe,
  NativeCliLaunchSpec,
  NativeCliProviderAdapter
} from '@/services/native-cli/types.ts';

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { defaultBinProbes } from '@/infra/resolve-binary.ts';

export type { NativeCliLaunchSpec, NativeCliProviderAdapter } from '@/services/native-cli/types.ts';

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
// declaration order, which listNativeCliAgentPresets preserves.
const ADAPTERS = new Map<NativeCliProvider, NativeCliProviderAdapter>();

export function registerAgentAdapterImpl(adapter: NativeCliProviderAdapter): void {
  ADAPTERS.set(adapter.provider, adapter);
}

/** Reverses a registerAgentAdapterImpl call. Production never needs this (adapters live for the
 *  daemon's lifetime); it exists so tests that register a throwaway provider can clean up afterward
 *  instead of leaking it into every other test sharing this module-level registry. */
export function unregisterAgentAdapterImpl(provider: NativeCliProvider): void {
  ADAPTERS.delete(provider);
}

function adapterFor(provider: NativeCliProvider): NativeCliProviderAdapter {
  const adapter = ADAPTERS.get(provider);
  if (!adapter) throw new Error(`no agent-adapter atom registered for provider "${provider}"`);
  return adapter;
}

function assertSafeArgs(agent: NativeCliAgentView): void {
  if (agent.allowAutopilot) return;
  const args = agent.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (isDangerousArg(arg, args[index + 1])) {
      throw new Error(`dangerous native CLI arg "${arg}" requires allowAutopilot`);
    }
  }
}

function assertCommandShape(agent: NativeCliAgentView): void {
  if (!agent.command.trim()) throw new Error(`native CLI agent "${agent.name}": command must not be blank`);
  if (/\s/.test(agent.command)) {
    throw new Error(`native CLI agent "${agent.name}": command must be a binary path or name; use args for flags`);
  }
}

export function buildNativeCliLaunch(
  agent: NativeCliAgentView,
  opts: BuildNativeCliLaunchOptions
): NativeCliLaunchSpec {
  assertSafeArgs(agent);
  if (!isAbsolute(opts.workingPath)) throw new Error('workingPath must be absolute');
  assertCommandShape(agent);
  return adapterFor(agent.provider).buildLaunch(agent, opts);
}

export function resolveNativeCliLaunchCommand(
  adapter: NativeCliProviderAdapter,
  launch: NativeCliLaunchSpec,
  probes: BinProbes = defaultBinProbes
): NativeCliLaunchSpec {
  const command = launch.argv[0];
  if (!command) throw new Error(`native CLI provider "${adapter.provider}": launch argv must include a command`);
  const resolvedCommand = adapter.resolveCommand?.(command, probes) ?? probes.which(command);
  if (!resolvedCommand) {
    throw new Error(`Executable not found in $PATH or known ${adapter.provider} install locations: "${command}"`);
  }
  if (resolvedCommand === command) return launch;
  return { ...launch, argv: [resolvedCommand, ...launch.argv.slice(1)] };
}

export function buildNativeCliAuthLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return adapterFor(agent.provider).buildAuthLaunch(agent);
}

export function buildNativeCliAuthStatusLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return adapterFor(agent.provider).authStatus(agent).launch;
}

export function buildNativeCliArgumentSupportProbe(
  agent: NativeCliAgentView
): NativeCliArgumentSupportProbe | undefined {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return adapterFor(agent.provider).argumentSupport?.(agent);
}

export function listNativeCliAgentModelOptions(
  agent: NativeCliAgentView,
  probes: BinProbes = defaultBinProbes
): string[] {
  const adapter = adapterFor(agent.provider);
  if (agent.modelOptions?.length) return agent.modelOptions;
  const fallback = adapter.listSupportedModels(agent);
  const probe = adapter.modelOptions?.(agent);
  if (!probe) return fallback;
  let launch: NativeCliLaunchSpec;
  try {
    launch = resolveNativeCliLaunchCommand(adapter, probe.launch, probes);
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

function probeNativeCliArgumentSupport(
  agent: NativeCliAgentView,
  probes: BinProbes = defaultBinProbes
): NativeCliArgumentSupport | undefined {
  const adapter = adapterFor(agent.provider);
  const probe = adapter.argumentSupport?.(agent);
  if (!probe) return undefined;
  let launch: NativeCliLaunchSpec;
  try {
    launch = resolveNativeCliLaunchCommand(adapter, probe.launch, probes);
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

export function listNativeCliAgentReasoningEfforts(
  agent: NativeCliAgentView,
  probes: BinProbes = defaultBinProbes
): string[] {
  const support = probeNativeCliArgumentSupport(agent, probes);
  return support?.reasoningEfforts ?? [];
}

/** Reasoning efforts split by model slug (the union is `listNativeCliAgentReasoningEfforts`). Shares
 *  the single argument-support probe, so it adds no extra provider spawn. */
export function listNativeCliAgentReasoningEffortsByModel(
  agent: NativeCliAgentView,
  probes: BinProbes = defaultBinProbes
): Record<string, string[]> | undefined {
  return probeNativeCliArgumentSupport(agent, probes)?.reasoningEffortsByModel;
}

export function getNativeCliProviderAdapter(provider: NativeCliProvider): NativeCliProviderAdapter {
  return adapterFor(provider);
}

/** Non-throwing registry lookup for display/notice code that must degrade gracefully when a provider
 *  has no registered adapter (never throws, unlike getNativeCliProviderAdapter). */
export function findNativeCliProviderAdapter(provider: NativeCliProvider): NativeCliProviderAdapter | undefined {
  return ADAPTERS.get(provider);
}

/** All registered agent adapters, in pack-declaration order. Lets cross-cutting features (e.g. the ACP
 *  delegation invite list) derive from the single adapter registry instead of a parallel static list. */
export function listNativeCliProviderAdapters(): NativeCliProviderAdapter[] {
  return [...ADAPTERS.values()];
}

function presetAgentView(preset: NativeCliAgentPresetView): NativeCliAgentView {
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

export function listNativeCliAgentPresets(probes: BinProbes = defaultBinProbes): NativeCliAgentPresetView[] {
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
      // listNativeCliAgentReasoningEfforts/listNativeCliAgentReasoningEffortsByModel call it
      // independently, which spawned the provider CLI twice per adapter for one settings-page load.
      const support = probeNativeCliArgumentSupport(agentView, probes);
      return {
        ...preset,
        modelOptions: listNativeCliAgentModelOptions(agentView, probes),
        reasoningEfforts: support?.reasoningEfforts ?? [],
        reasoningEffortsByModel: support?.reasoningEffortsByModel
      };
    });
}
