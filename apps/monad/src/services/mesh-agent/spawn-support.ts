import type { MeshAgentView } from '@monad/protocol';

import { mergeMeshAgentChildEnv } from '#/services/mesh-agent/env.ts';

export type ResolveAgentEnv = (env?: Record<string, string>) => Promise<Record<string, string> | undefined>;

/** Resolve secret refs in the launch env, then merge with the daemon env (minus nested-session
 *  markers and injection vectors) to form the child CLI's environment. `resolveAgentEnv` absent
 *  (tests) → the env is used verbatim. */
export async function buildMeshAgentSpawnEnv(
  resolveAgentEnv: ResolveAgentEnv | undefined,
  launchEnv?: Record<string, string>
): Promise<Record<string, string>> {
  const resolved = resolveAgentEnv ? await resolveAgentEnv(launchEnv) : launchEnv;
  return mergeMeshAgentChildEnv(resolved);
}

export async function requireMeshAgent(agents: () => Promise<MeshAgentView[]>, name: string): Promise<MeshAgentView> {
  const agent = (await agents()).find((candidate) => candidate.name === name && candidate.enabled);
  if (!agent) throw new Error(`MeshAgent not found or disabled: ${name}`);
  return agent;
}
