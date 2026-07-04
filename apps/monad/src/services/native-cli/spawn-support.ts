import type { NativeCliAgentView } from '@monad/protocol';

import { mergeNativeCliChildEnv } from '@/services/native-cli/env.ts';

export type ResolveAgentEnv = (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;

/** Resolve secret refs in the launch env, then merge with the daemon env (minus nested-session
 *  markers and injection vectors) to form the child CLI's environment. `resolveAgentEnv` absent
 *  (tests) → the env is used verbatim. */
export async function buildNativeCliSpawnEnv(
  resolveAgentEnv: ResolveAgentEnv | undefined,
  launchEnv?: Record<string, string>
): Promise<Record<string, string>> {
  const resolved = resolveAgentEnv ? await resolveAgentEnv(launchEnv) : launchEnv;
  return mergeNativeCliChildEnv(resolved);
}

export async function requireNativeCliAgent(
  agents: () => Promise<NativeCliAgentView[]>,
  name: string
): Promise<NativeCliAgentView> {
  const agent = (await agents()).find((candidate) => candidate.name === name && candidate.enabled);
  if (!agent) throw new Error(`native CLI agent not found or disabled: ${name}`);
  return agent;
}
