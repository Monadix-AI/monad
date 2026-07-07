import type { ExternalAgentAuthSessionView, ExternalAgentView } from '@monad/protocol';

export interface ExternalAgentConnectAgentDeps {
  saveAgent(agent: ExternalAgentView): Promise<void>;
  removeAgent(agentName: string): Promise<void>;
  startAuth(agentName: string): Promise<ExternalAgentAuthSessionView>;
}

export interface ExternalAgentConnectAgentResult {
  session: ExternalAgentAuthSessionView;
  persisted: boolean;
}

export async function connectExternalAgent(
  agent: ExternalAgentView,
  deps: ExternalAgentConnectAgentDeps
): Promise<ExternalAgentConnectAgentResult> {
  await deps.saveAgent(agent);
  let session: ExternalAgentAuthSessionView;
  try {
    session = await deps.startAuth(agent.name);
  } catch (error) {
    await deps.removeAgent(agent.name);
    throw error;
  }
  const persisted = session.authState === 'authenticated';
  if (!persisted) await deps.removeAgent(agent.name);
  return { session, persisted };
}
