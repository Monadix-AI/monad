import type { MeshAgentAuthSessionView, MeshAgentView } from '@monad/protocol';

export interface MeshAgentConnectAgentDeps {
  saveAgent(agent: MeshAgentView): Promise<void>;
  removeAgent(agentName: string): Promise<void>;
  startAuth(agentName: string): Promise<MeshAgentAuthSessionView>;
}

export interface MeshAgentConnectAgentResult {
  session: MeshAgentAuthSessionView;
  persisted: boolean;
}

export async function connectMeshAgent(
  agent: MeshAgentView,
  deps: MeshAgentConnectAgentDeps
): Promise<MeshAgentConnectAgentResult> {
  await deps.saveAgent(agent);
  let session: MeshAgentAuthSessionView;
  try {
    session = await deps.startAuth(agent.name);
  } catch (error) {
    await deps.removeAgent(agent.name);
    throw error;
  }
  const persisted = session.authState === 'authenticated';
  return { session, persisted };
}
