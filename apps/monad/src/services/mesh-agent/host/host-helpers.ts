import type { MeshSessionId, MeshSessionView, SessionId } from '@monad/protocol';
import type { MeshAgentOutputEvent } from '#/services/mesh-agent/types.ts';
import type { MeshSessionRow } from '#/store/db/index.ts';

import { getMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';

// TODO(track-b): `MeshSessionView.sessionId` is now strictly a `SessionId` on the wire
// (packages/protocol/src/mesh-agent/mesh-session.ts) — the Track B P6b id collapse
// narrowed this response shape's identity field. `row.transcriptTargetId` (the store row, see
// apps/monad/src/store/db/mesh-sessions.ts's `MeshAgentTargetId`) is still genuinely
// `SessionId | ProjectId` internally, so a project-scoped runtime's view cast here is a real,
// pre-existing lossy narrowing this pass does not resolve (open class-C question).
export function toView(row: MeshSessionRow, pendingApprovalCount = 0): MeshSessionView {
  const { transcriptTargetId, ...view } = row;
  return {
    ...view,
    id: view.id as MeshSessionId,
    sessionId: transcriptTargetId as SessionId,
    productIcon: getMeshAgentProviderAdapter(row.provider).productIcon,
    pendingApprovalCount,
    approvalOwnership: 'provider-owned',
    outputSnapshot: ''
  };
}

export function nativeAgentMcpToolError(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return record.event === 'native_agent_mcp_tool_error' ? record : null;
  } catch {
    return null;
  }
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
