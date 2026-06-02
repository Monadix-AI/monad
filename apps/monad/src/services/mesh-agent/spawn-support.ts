import type { MeshAgentProvider, MeshAgentView } from '@monad/protocol';
import type { MeshAgentProviderAdapter } from '#/services/mesh-agent/types.ts';

import { mergeMeshAgentChildEnv, meshAgentStripKeys } from '#/services/mesh-agent/env.ts';

export type ResolveAgentEnv = (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;

/** Resolve secret refs in the launch env, then merge it over the daemon env and apply `adapter`'s
 *  strip invariant (native delivery — the ACP wrapper builds its env in `acp-env.ts`). `adapter` is
 *  required so a spawn path can't silently skip the policy.
 *  `resolveAgentEnv` absent (tests) → the env is used verbatim. */
export async function buildMeshAgentSpawnEnv(
  resolveAgentEnv: ResolveAgentEnv | undefined,
  adapter: MeshAgentProviderAdapter,
  launchEnv?: Record<string, string>
): Promise<Record<string, string>> {
  const resolved = resolveAgentEnv ? await resolveAgentEnv(launchEnv) : launchEnv;
  return mergeMeshAgentChildEnv(resolved, meshAgentStripKeys(adapter.environment));
}

export async function requireMeshAgent(agents: () => Promise<MeshAgentView[]>, name: string): Promise<MeshAgentView> {
  const agent = (await agents()).find((candidate) => candidate.name === name && candidate.enabled);
  if (!agent) throw new Error(`MeshAgent not found or disabled: ${name}`);
  return agent;
}

export async function requireMeshSessionAgent(
  agents: () => Promise<MeshAgentView[]>,
  name: string,
  provider: MeshAgentProvider
): Promise<MeshAgentView> {
  const configured = await agents();
  const exact = configured.find((candidate) => candidate.name === name && candidate.enabled);
  if (exact) return exact;
  const providerMatches = configured.filter((candidate) => candidate.provider === provider && candidate.enabled);
  const onlyMatch = providerMatches[0];
  if (providerMatches.length === 1 && onlyMatch) return onlyMatch;
  throw new Error(`MeshAgent not found or disabled: ${name}`);
}
