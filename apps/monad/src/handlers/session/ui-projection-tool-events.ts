import type { Event, SessionUiEvent, UIItem } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { parseEventPayload } from '@monad/protocol';

import { findMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';
import { isUnknownToolResult, itemKey } from './ui-projection-helpers.ts';

function settleBuiltInStreamingMessages(m: ProjectionMutations): SessionUiEvent[] {
  const settled: SessionUiEvent[] = [];
  for (const item of m.items.values()) {
    if (item.kind !== 'message' || item.role !== 'assistant' || item.status !== 'streaming' || item.source) continue;
    m.rawStreamingText.delete(item.id);
    m.channelDisplayCache.delete(item.id);
    settled.push(m.setMessage({ ...item, status: 'done' }));
  }
  return settled;
}

export function applyToolEvent(m: ProjectionMutations, event: Event): SessionUiEvent[] | undefined {
  switch (event.type) {
    case 'tool.called': {
      const p = parseEventPayload('tool.called', event.payload);
      return [
        ...settleBuiltInStreamingMessages(m),
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'tool',
            id: p.toolCallId,
            tool: p.tool,
            ...(p.input !== undefined ? { input: p.input } : {}),
            status: 'running',
            seq: event.id
          })
        }
      ];
    }
    case 'tool.result': {
      const p = parseEventPayload('tool.result', event.payload);
      if (!p.ok && isUnknownToolResult(p.tool, p.result)) return [m.remove('tool', p.toolCallId)];
      const existing = m.items.get(itemKey('tool', p.toolCallId));
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.toolCallId,
        tool: existing?.kind === 'tool' ? existing.tool : 'tool',
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        ...((p.displayResult ?? p.result) ? { output: p.displayResult ?? p.result } : {}),
        ...('display' in p ? { display: p.display } : {}),
        ...(p.errorCode !== undefined ? { errorCode: p.errorCode } : {}),
        status: p.ok ? 'ok' : 'error',
        seq: existing?.kind === 'tool' ? existing.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'tool.progress': {
      const p = parseEventPayload('tool.progress', event.payload);
      const existing = m.items.get(itemKey('tool', p.toolCallId));
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.toolCallId,
        tool: existing?.kind === 'tool' ? existing.tool : p.tool,
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        output: `${existing?.kind === 'tool' && existing.output ? `${existing.output}\n` : ''}${p.output}`,
        status: 'running',
        seq: existing?.kind === 'tool' ? existing.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'mesh.started': {
      const p = parseEventPayload('mesh.started', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'tool',
            id: p.meshSessionId,
            tool: `mesh-agent:${p.provider}`,
            input: {
              agent: p.agentName,
              provider: p.provider,
              productIcon: p.productIcon,
              workingPath: p.workingPath,
              approvalOwnership: 'provider-owned'
            },
            status: 'running',
            seq: event.id
          })
        }
      ];
    }
    case 'mesh.login_required': {
      const p = parseEventPayload('mesh.login_required', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'custom',
            id: `mesh-agent-login-required:${p.agentName}`,
            name: 'mesh.login_required',
            status: 'error',
            data: p,
            seq: event.id
          })
        }
      ];
    }
    case 'mesh.login_resolved': {
      const p = parseEventPayload('mesh.login_resolved', event.payload);
      return [m.remove('custom', `mesh-agent-login-required:${p.agentName}`)];
    }
    case 'mesh.connection_required': {
      const p = parseEventPayload('mesh.connection_required', event.payload);
      if (p.code === 'authentication_failed') {
        return [
          {
            kind: 'upsert',
            cursor: event.id,
            item: m.upsert({
              kind: 'custom',
              id: `mesh-agent-login-required:${p.agentName}`,
              name: 'mesh.login_required',
              status: 'error',
              data: {
                ...(p.meshSessionId ? { meshSessionId: p.meshSessionId } : {}),
                agentName: p.agentName,
                ...(p.authAgentName ? { authAgentName: p.authAgentName } : {}),
                provider: p.provider,
                reason: p.reason
              },
              seq: event.id
            })
          }
        ];
      }
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'custom',
            id: `mesh-agent-connection-required:${p.meshSessionId ?? p.agentName}`,
            name: 'mesh.connection_required',
            status: 'error',
            data: p,
            seq: event.id
          })
        }
      ];
    }
    case 'mesh.approval_requested': {
      const p = parseEventPayload('mesh.approval_requested', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'approval',
            id: p.requestId,
            tool: `${p.provider} approval`,
            input: {
              meshSessionId: p.meshSessionId,
              provider: p.provider,
              text: p.text,
              data: p.data,
              approvalOwnership: 'provider-owned'
            },
            key: `provider-owned:${p.provider}`,
            seq: event.id
          })
        }
      ];
    }
    case 'mesh.approval_resolved': {
      const p = parseEventPayload('mesh.approval_resolved', event.payload);
      return [m.remove('approval', p.requestId)];
    }
    case 'mesh.idle_suspended':
    case 'mesh.idle_resumed':
      return [];
    case 'mesh.resume_failed': {
      const p = parseEventPayload('mesh.resume_failed', event.payload);
      const label = findMeshAgentProviderAdapter(p.provider)?.label ?? p.provider;
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'system',
            id: `mesh-agent-resume-failed:${p.agentName}:${p.providerSessionRef}`,
            text: m.t('daemon.session.meshAgentResumeFailed', { label, ref: p.providerSessionRef }),
            level: 'warn',
            seq: event.id
          })
        }
      ];
    }
    case 'mesh.turn_started': {
      const p = parseEventPayload('mesh.turn_started', event.payload);
      const existing = m.items.get(itemKey('tool', p.meshSessionId));
      if (existing?.kind !== 'tool' || existing.status === 'running') return [];
      const next: Extract<UIItem, { kind: 'tool' }> = {
        ...existing,
        status: 'running',
        seq: existing.seq
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'mesh.turn_settled': {
      const p = parseEventPayload('mesh.turn_settled', event.payload);
      const existing = m.items.get(itemKey('tool', p.meshSessionId));
      if (existing?.kind !== 'tool' || existing.status !== 'running') return [];
      const next: Extract<UIItem, { kind: 'tool' }> = {
        ...existing,
        status: p.error ? 'error' : 'ok',
        seq: existing.seq
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'mesh.exited': {
      const p = parseEventPayload('mesh.exited', event.payload);
      const existing = m.items.get(itemKey('tool', p.meshSessionId));
      const exitText = p.exitCode === null ? `\n${p.state}` : `\n${p.state} (${p.exitCode})`;
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.meshSessionId,
        tool: existing?.kind === 'tool' ? existing.tool : 'mesh-agent',
        ...(existing?.kind === 'tool' && existing.input !== undefined ? { input: existing.input } : {}),
        output: `${existing?.kind === 'tool' && existing.output ? existing.output : ''}${exitText}`,
        status: p.state === 'failed' ? 'error' : 'ok',
        seq: existing?.kind === 'tool' ? existing.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    default:
      return undefined;
  }
}
