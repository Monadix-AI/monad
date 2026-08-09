import type { MeshSessionView } from '@monad/protocol';

export function mergeMeshAgentSessions(
  listedSessions: readonly MeshSessionView[],
  streamedSessions: readonly MeshSessionView[]
): MeshSessionView[] {
  const sessions = new Map(listedSessions.map((session) => [session.id, session]));
  for (const streamed of streamedSessions) {
    const listed = sessions.get(streamed.id);
    if (!listed) {
      sessions.set(streamed.id, streamed);
      continue;
    }
    const [older, newer] = listed.updatedAt > streamed.updatedAt ? [streamed, listed] : [listed, streamed];
    const productIcon = newer.productIcon ?? older.productIcon;
    sessions.set(streamed.id, { ...older, ...newer, ...(productIcon ? { productIcon } : {}) });
  }
  return [...sessions.values()];
}
