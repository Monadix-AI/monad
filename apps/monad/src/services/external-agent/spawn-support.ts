import type { ExternalAgentView } from '@monad/protocol';

import { mergeExternalAgentChildEnv } from '@/services/external-agent/env.ts';

export type ResolveAgentEnv = (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;

/** Resolve secret refs in the launch env, then merge with the daemon env (minus nested-session
 *  markers and injection vectors) to form the child CLI's environment. `resolveAgentEnv` absent
 *  (tests) → the env is used verbatim. */
export async function buildExternalAgentSpawnEnv(
  resolveAgentEnv: ResolveAgentEnv | undefined,
  launchEnv?: Record<string, string>
): Promise<Record<string, string>> {
  const resolved = resolveAgentEnv ? await resolveAgentEnv(launchEnv) : launchEnv;
  return mergeExternalAgentChildEnv(resolved);
}

export async function requireExternalAgent(
  agents: () => Promise<ExternalAgentView[]>,
  name: string
): Promise<ExternalAgentView> {
  const agent = (await agents()).find((candidate) => candidate.name === name && candidate.enabled);
  if (!agent) throw new Error(`external agent not found or disabled: ${name}`);
  return agent;
}
