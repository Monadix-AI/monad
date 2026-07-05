import type { NativeCliSessionView } from '@monad/protocol';
import type { LiveNativeCliSession } from '@/services/native-cli/host-types.ts';
import type { NativeCliOutputEvent } from '@/services/native-cli/types.ts';
import type { NativeCliSessionRow } from '@/store/db/index.ts';

import { getNativeCliProviderAdapter } from '@/services/native-cli/index.ts';

export function isManagedProjectRuntime(
  runtime: Pick<NativeCliSessionRow | LiveNativeCliSession, 'runtimeRole'>
): boolean {
  return runtime.runtimeRole === 'managed-project-agent';
}

export function toView(
  row: NativeCliSessionRow,
  pendingApprovalCount = 0,
  live?: LiveNativeCliSession
): NativeCliSessionView {
  const { transcriptTargetId, ...view } = row;
  return {
    ...view,
    transcriptTargetId: transcriptTargetId,
    productIcon: getNativeCliProviderAdapter(row.provider).productIcon,
    pendingApprovalCount,
    approvalOwnership: 'provider-owned',
    outputSnapshot: live ? live.outputBuffer.snapshot() : row.outputSnapshot
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

export function nativeCliApprovalText(event: NativeCliOutputEvent): string {
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
