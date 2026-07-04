import type { NativeCliAgentView, NativeCliAuthSessionView } from '@monad/protocol';

export interface NativeCliConnectAgentDeps {
  saveAgent(agent: NativeCliAgentView): Promise<void>;
  removeAgent(agentName: string): Promise<void>;
  startAuth(agentName: string): Promise<NativeCliAuthSessionView>;
}

export interface NativeCliConnectAgentResult {
  session: NativeCliAuthSessionView;
  persisted: boolean;
}

export async function connectNativeCliAgent(
  agent: NativeCliAgentView,
  deps: NativeCliConnectAgentDeps
): Promise<NativeCliConnectAgentResult> {
  await deps.saveAgent(agent);
  let session: NativeCliAuthSessionView;
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
