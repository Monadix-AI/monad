import type { NativeCliAgentPresetView, NativeCliAgentView, NativeCliProvider } from '@monad/protocol';
import type { BinProbes } from '@/infra/resolve-binary.ts';
import type { NativeCliLaunchSpec, NativeCliProviderAdapter } from '@/services/native-cli/types.ts';

import { isAbsolute } from 'node:path';

import { defaultBinProbes } from '@/infra/resolve-binary.ts';
import { claudeCodeNativeCliAdapter } from '@/services/native-cli/claude-code.ts';
import { codexNativeCliAdapter } from '@/services/native-cli/codex.ts';

export type {
  NativeCliLaunchSpec,
  NativeCliProviderAdapter
} from '@/services/native-cli/types.ts';

export { claudeCodeNativeCliAdapter } from '@/services/native-cli/claude-code.ts';
export { codexNativeCliAdapter } from '@/services/native-cli/codex.ts';

const DANGEROUS_ARGS = new Set([
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions'
]);

const ADAPTERS: Record<NativeCliProvider, NativeCliProviderAdapter> = {
  codex: codexNativeCliAdapter,
  'claude-code': claudeCodeNativeCliAdapter
};

function assertSafeArgs(agent: NativeCliAgentView): void {
  if (agent.allowDangerousMode) return;
  for (const arg of agent.args ?? []) {
    if (DANGEROUS_ARGS.has(arg)) throw new Error(`dangerous native CLI arg "${arg}" requires allowDangerousMode`);
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
  opts: { workingPath: string; launchMode?: NativeCliLaunchSpec['launchMode']; providerSessionRef?: string }
): NativeCliLaunchSpec {
  assertSafeArgs(agent);
  if (!isAbsolute(opts.workingPath)) throw new Error('workingPath must be absolute');
  assertCommandShape(agent);
  return ADAPTERS[agent.provider].buildLaunch(agent, opts);
}

export function buildNativeCliAuthLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return ADAPTERS[agent.provider].buildAuthLaunch(agent);
}

export function buildNativeCliAuthStatusLaunch(agent: NativeCliAgentView): NativeCliLaunchSpec {
  assertSafeArgs(agent);
  assertCommandShape(agent);
  return ADAPTERS[agent.provider].buildAuthStatusLaunch(agent);
}

export function getNativeCliProviderAdapter(provider: NativeCliProvider): NativeCliProviderAdapter {
  return ADAPTERS[provider];
}

export function listNativeCliAgentPresets(probes: BinProbes = defaultBinProbes): NativeCliAgentPresetView[] {
  return [codexNativeCliAdapter.detect(probes), claudeCodeNativeCliAdapter.detect(probes)];
}
