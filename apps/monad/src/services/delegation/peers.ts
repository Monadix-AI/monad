import type { MonadAuth, MonadConfig } from '@monad/environment';
import type { Logger } from '@monad/logger';
import type { Tool } from '#/capabilities/tools/types.ts';

import { emptyAuth, resolvePeerSecretRef } from '@monad/environment';

import { createPeerDelegateTool, type PeerDelegateTarget } from '#/services/delegation/peer-delegate.ts';

// monad-as-peer-client: expose `agent_peer_delegate` only for enabled peers whose token resolves
// (a peer configured but missing its auth.json credential is skipped, not fatal). The peer runs the
// subtask self-contained over its OpenAI-compat API; see ../services/delegation/peer-delegate.ts.
export function createPeerDelegateTools(deps: {
  peers: MonadConfig['peers'];
  auth: MonadAuth | undefined;
  gate: Parameters<typeof createPeerDelegateTool>[0]['gate'];
  logger: Logger;
}): Tool[] {
  const { peers, auth, gate, logger } = deps;
  const peerTargets: PeerDelegateTarget[] = [];
  for (const p of peers.filter((x) => x.enabled)) {
    try {
      const token = resolvePeerSecretRef(p.tokenRef, auth ?? emptyAuth());
      peerTargets.push({ id: p.id, label: p.label, baseUrl: p.baseUrl, defaultAgent: p.defaultAgent, token });
    } catch (err) {
      logger.warn({ peer: p.id, err: String(err) }, 'skipping peer with unresolved token');
    }
  }
  return peerTargets.length > 0 ? [createPeerDelegateTool({ peers: peerTargets, gate })] : [];
}
