import type { ExternalAgentSessionId, ExternalAgentSessionView, SessionId } from '@monad/protocol';
import type { LiveExternalAgentSession } from '#/services/external-agent/host/host-types.ts';
import type { ExternalAgentOutputEvent } from '#/services/external-agent/types.ts';
import type { ExternalAgentSessionRow } from '#/store/db/index.ts';

import { getExternalAgentProviderAdapter } from '#/services/external-agent/index.ts';

export function isManagedProjectRuntime(
  runtime: Pick<ExternalAgentSessionRow | LiveExternalAgentSession, 'runtimeRole'>
): boolean {
  return runtime.runtimeRole === 'managed-project-agent';
}

// TODO(track-b): `ExternalAgentSessionView.sessionId` is now strictly a `SessionId` on the wire
// (packages/protocol/src/external-agent/external-agent-session.ts) — the Track B P6b id collapse
// narrowed this response shape's identity field. `row.transcriptTargetId` (the store row, see
// apps/monad/src/store/db/external-agent-sessions.ts's `ExternalAgentTargetId`) is still genuinely
// `SessionId | ProjectId` internally, so a project-scoped runtime's view cast here is a real,
// pre-existing lossy narrowing this pass does not resolve (open class-C question).
export function toView(row: ExternalAgentSessionRow, pendingApprovalCount = 0): ExternalAgentSessionView {
  const { transcriptTargetId, ...view } = row;
  return {
    ...view,
    id: view.id as ExternalAgentSessionId,
    sessionId: transcriptTargetId as SessionId,
    productIcon: getExternalAgentProviderAdapter(row.provider).productIcon,
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

export function externalAgentApprovalText(event: ExternalAgentOutputEvent): string {
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
