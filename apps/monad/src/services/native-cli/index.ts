import type { NativeCliAgentPresetView, NativeCliAgentView, NativeCliProvider } from '@monad/protocol';
import type { BinProbes } from '@/infra/resolve-binary.ts';
import type {
  BuildNativeCliLaunchOptions,
  NativeCliArgumentSupport,
  NativeCliArgumentSupportProbe,
  NativeCliLaunchSpec,
  NativeCliModelOptionsProbe,
  NativeCliProviderAdapter
} from '@/services/native-cli/types.ts';

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

import { defaultBinProbes } from '@/infra/resolve-binary.ts';
import { claudeCodeNativeCliAdapter } from '@/services/native-cli/claude-code.ts';
import { codexNativeCliAdapter } from '@/services/native-cli/codex.ts';
import { geminiNativeCliAdapter } from '@/services/native-cli/gemini.ts';
import { qwenNativeCliAdapter } from '@/services/native-cli/qwen.ts';

export type {
  NativeCliLaunchSpec,
  NativeCliProviderAdapter
} from '@/services/native-cli/types.ts';

export { claudeCodeNativeCliAdapter } from '@/services/native-cli/claude-code.ts';
export { codexNativeCliAdapter } from '@/services/native-cli/codex.ts';
export { geminiNativeCliAdapter } from '@/services/native-cli/gemini.ts';
export { qwenNativeCliAdapter } from '@/services/native-cli/qwen.ts';

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

const ADAPTERS: Record<NativeCliProvider, NativeCliProviderAdapter> = {
  codex: codexNativeCliAdapter,
  'claude-code': claudeCodeNativeCliAdapter,
  gemini: geminiNativeCliAdapter,
  qwen: qwenNativeCliAdapter
};

function assertSafeArgs(agent: NativeCliAgentView): void {
  if (agent.allowDangerousMode) return;
  const args = agent.args ?? [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (isDangerousArg(arg, args[index + 1])) {
      throw new Error(`dangerous native CLI arg "${arg}" requires allowDangerousMode`);
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
  return ADAPTERS[agent.provider].buildLaunch(agent, opts);
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
  return ADAPTERS[agent.provider].buildAuthLaunch(agent);
}

export function buildNativeCliAuthStatusLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return ADAPTERS[agent.provider].authStatus(agent).launch;
}

export function buildNativeCliModelOptionsProbe(agent: NativeCliAgentView): NativeCliModelOptionsProbe | undefined {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return ADAPTERS[agent.provider].modelOptions?.(agent);
}

export function buildNativeCliArgumentSupportProbe(
  agent: NativeCliAgentView
): NativeCliArgumentSupportProbe | undefined {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return ADAPTERS[agent.provider].argumentSupport?.(agent);
}

export function probeNativeCliArgumentSupport(
  agent: NativeCliAgentView,
  probes: BinProbes = defaultBinProbes
): NativeCliArgumentSupport | undefined {
  const adapter = ADAPTERS[agent.provider];
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

export function listNativeCliAgentModelOptions(
  agent: NativeCliAgentView,
  probes: BinProbes = defaultBinProbes
): string[] {
  const adapter = ADAPTERS[agent.provider];
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

export function listNativeCliAgentReasoningEfforts(
  agent: NativeCliAgentView,
  probes: BinProbes = defaultBinProbes
): string[] {
  const support = probeNativeCliArgumentSupport(agent, probes);
  return support?.reasoningEfforts ?? [];
}

export function getNativeCliProviderAdapter(provider: NativeCliProvider): NativeCliProviderAdapter {
  return ADAPTERS[provider];
}

export function listNativeCliAgentPresets(probes: BinProbes = defaultBinProbes): NativeCliAgentPresetView[] {
  return [
    codexNativeCliAdapter.detect(probes),
    claudeCodeNativeCliAdapter.detect(probes),
    geminiNativeCliAdapter.detect(probes),
    qwenNativeCliAdapter.detect(probes)
  ].map((preset) => ({
    ...preset,
    modelOptions: listNativeCliAgentModelOptions(
      {
        name: preset.id,
        provider: preset.provider,
        productIcon: preset.productIcon,
        command: preset.command,
        args: preset.args,
        enabled: preset.installed,
        defaultLaunchMode: preset.defaultLaunchMode,
        allowDangerousMode: false,
        approvalOwnership: 'provider-owned'
      },
      probes
    ),
    reasoningEfforts: listNativeCliAgentReasoningEfforts(
      {
        name: preset.id,
        provider: preset.provider,
        productIcon: preset.productIcon,
        command: preset.command,
        args: preset.args,
        enabled: preset.installed,
        defaultLaunchMode: preset.defaultLaunchMode,
        allowDangerousMode: false,
        approvalOwnership: 'provider-owned'
      },
      probes
    )
  }));
}
