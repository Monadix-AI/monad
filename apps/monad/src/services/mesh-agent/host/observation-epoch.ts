import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';

import { MeshAgentEventLog } from '#/services/mesh-agent/host/event-log.ts';

interface MeshAgentObservationEpochContext {
  events: MeshAgentEventLog;
}

export class MeshAgentObservationEpoch {
  constructor(private readonly context: MeshAgentObservationEpochContext) {}

  emitConnectionOpened(live: LiveMeshSession): void {
    live.connectionOpen = true;
    this.context.events.publish(live.transcriptTargetId, 'mesh.session.connection.opened', {
      meshSessionId: live.id,
      provider: live.provider,
      observationEpoch: live.observationEpoch
    });
  }

  emitConnectionClosed(live: LiveMeshSession, reason: 'exited' | 'failed' | 'stopped' | 'disconnected'): void {
    if (!live.connectionOpen) return;
    live.connectionOpen = false;
    this.context.events.publish(live.transcriptTargetId, 'mesh.session.connection.closed', {
      meshSessionId: live.id,
      provider: live.provider,
      observationEpoch: live.observationEpoch,
      reason
    });
  }
}
