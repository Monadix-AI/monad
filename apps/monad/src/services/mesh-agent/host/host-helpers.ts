import type {
  MeshAgentRuntimeCapabilities,
  MeshExecutionActivity,
  MeshSessionId,
  MeshSessionLifecycle,
  MeshSessionView,
  SessionId
} from '@monad/protocol';
import type { SessionEventRuntimeSnapshot } from '#/services/mesh-agent/session-event-runtime/types.ts';
import type { MeshAgentOutputEvent } from '#/services/mesh-agent/types.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { getMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';

// TODO(track-b): `MeshSessionView.sessionId` is now strictly a `SessionId` on the wire
// (packages/protocol/src/mesh-agent/mesh-session.ts) — the Track B P6b id collapse
// narrowed this response shape's identity field. `row.transcriptTargetId` (the store row, see
// apps/monad/src/store/db/mesh-sessions.ts's `MeshAgentTargetId`) is still genuinely
// `SessionId | ProjectId` internally, so a project-scoped runtime's view cast here is a real,
// pre-existing lossy narrowing this pass does not resolve (open class-C question).
const NO_RUNTIME_CAPABILITIES: MeshAgentRuntimeCapabilities = {
  input: false,
  steer: false,
  interrupt: false,
  approvalResolution: false,
  providerSessionContinuation: false,
  runtimeRestoration: false,
  sessionReopen: false
};

function lifecycleOf(row: MeshSessionRow): MeshSessionLifecycle {
  if (row.state === 'starting') return { state: 'starting' };
  if (row.state === 'running') return { state: 'active' };
  return {
    state: 'terminal',
    termination: {
      kind: row.state,
      at: row.exitedAt ?? row.updatedAt,
      ...(row.exitCode !== null ? { exitCode: row.exitCode } : {})
    }
  };
}

function activityOf(row: MeshSessionRow): MeshExecutionActivity {
  return row.state === 'running' && row.pid
    ? { state: 'running', pid: row.pid, queuedTurnCount: 0 }
    : { state: 'idle', pid: null, queuedTurnCount: 0 };
}

export function toView(
  row: MeshSessionRow,
  pendingApprovalCount = 0,
  runtime?: SessionEventRuntimeSnapshot
): MeshSessionView {
  return {
    id: row.id as MeshSessionId,
    sessionId: row.transcriptTargetId as SessionId,
    agentName: row.agentName,
    provider: row.provider,
    productIcon: getMeshAgentProviderAdapter(row.provider).productIcon,
    workingPath: row.workingPath,
    runtimeRole: row.runtimeRole,
    agentRuntimeId: row.agentRuntimeId,
    lastDeliveredSeq: row.lastDeliveredSeq,
    lastVisibleSeq: row.lastVisibleSeq,
    pendingApprovalCount,
    approvalOwnership: 'provider-owned',
    lifecycle: runtime?.lifecycle ?? lifecycleOf(row),
    activity: runtime?.activity ?? activityOf(row),
    connection: runtime?.connection ?? { state: 'inactive' },
    capabilities: runtime?.capabilities ?? NO_RUNTIME_CAPABILITIES,
    providerSessionRef: runtime?.providerSessionRef ?? row.providerSessionRef,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt
  };
}

export function meshAgentApprovalText(event: MeshAgentOutputEvent): string {
  const action = typeof event.payload.action === 'string' ? event.payload.action : undefined;
  const command = typeof event.payload.command === 'string' ? event.payload.command : undefined;
  const reason = typeof event.payload.reason === 'string' ? event.payload.reason : undefined;
  const kind = typeof event.payload.kind === 'string' ? event.payload.kind : 'approval';
  if (action) return action;
  if (command && reason) return `${kind}: ${command} (${reason})`;
  if (command) return `${kind}: ${command}`;
  if (reason) return `${kind}: ${reason}`;
  return kind;
}
