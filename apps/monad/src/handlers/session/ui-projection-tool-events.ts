import type { Event, SessionUiEvent, UIItem } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { parseEventPayload } from '@monad/protocol';

import { findExternalAgentProviderAdapter } from '#/services/external-agent/index.ts';
import {
  appendBoundedText,
  externalAgentProviderFromToolItem,
  externalAgentSnapshotIsGenerating,
  isUnknownToolResult,
  itemKey,
  MAX_EXTERNAL_AGENT_UI_OUTPUT
} from './ui-projection-helpers.ts';

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
    case 'external_agent.started': {
      const p = parseEventPayload('external_agent.started', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'tool',
            id: p.externalAgentSessionId,
            tool: `external-agent:${p.provider}`,
            input: {
              agent: p.agentName,
              provider: p.provider,
              productIcon: p.productIcon,
              workingPath: p.workingPath,
              launchMode: p.launchMode,
              approvalOwnership: 'provider-owned'
            },
            status: 'running',
            seq: event.id
          })
        }
      ];
    }
    case 'external_agent.output': {
      const p = parseEventPayload('external_agent.output', event.payload);
      const existing = m.items.get(itemKey('tool', p.externalAgentSessionId));
      const existingTool = existing?.kind === 'tool' ? existing : undefined;
      const output = existingTool
        ? appendBoundedText(existingTool.output ?? '', p.chunk, MAX_EXTERNAL_AGENT_UI_OUTPUT)
        : p.chunk;
      const provider = externalAgentProviderFromToolItem(existingTool);
      const generating = provider === undefined ? undefined : externalAgentSnapshotIsGenerating(output, provider);
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.externalAgentSessionId,
        tool: existingTool ? existingTool.tool : 'external-agent',
        ...(existingTool?.input !== undefined ? { input: existingTool.input } : {}),
        output,
        status:
          generating === undefined ? (existingTool ? existingTool.status : 'running') : generating ? 'running' : 'ok',
        seq: existingTool ? existingTool.seq : event.id
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'external_agent.connection_required': {
      const p = parseEventPayload('external_agent.connection_required', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'custom',
            id: `external-agent-connection-required:${p.externalAgentSessionId ?? p.agentName}`,
            name: 'external_agent.connection_required',
            status: 'error',
            data: p,
            seq: event.id
          })
        }
      ];
    }
    case 'external_agent.approval_requested': {
      const p = parseEventPayload('external_agent.approval_requested', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'approval',
            id: p.requestId,
            tool: `${p.provider} approval`,
            input: {
              externalAgentSessionId: p.externalAgentSessionId,
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
    case 'external_agent.approval_resolved': {
      const p = parseEventPayload('external_agent.approval_resolved', event.payload);
      return [m.remove('approval', p.requestId)];
    }
    case 'external_agent.resume_failed': {
      const p = parseEventPayload('external_agent.resume_failed', event.payload);
      const label = findExternalAgentProviderAdapter(p.provider)?.label ?? p.provider;
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'system',
            id: `external-agent-resume-failed:${p.agentName}:${p.providerSessionRef}`,
            text: m.t('daemon.session.externalAgentResumeFailed', { label, ref: p.providerSessionRef }),
            level: 'warn',
            seq: event.id
          })
        }
      ];
    }
    case 'external_agent.turn_settled': {
      const p = parseEventPayload('external_agent.turn_settled', event.payload);
      const existing = m.items.get(itemKey('tool', p.externalAgentSessionId));
      if (existing?.kind !== 'tool' || existing.status !== 'running') return [];
      const next: Extract<UIItem, { kind: 'tool' }> = {
        ...existing,
        status: p.error ? 'error' : 'ok',
        seq: existing.seq
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    case 'external_agent.exited': {
      const p = parseEventPayload('external_agent.exited', event.payload);
      const existing = m.items.get(itemKey('tool', p.externalAgentSessionId));
      const exitText = p.exitCode === null ? `\n${p.state}` : `\n${p.state} (${p.exitCode})`;
      const next: Extract<UIItem, { kind: 'tool' }> = {
        kind: 'tool',
        id: p.externalAgentSessionId,
        tool: existing?.kind === 'tool' ? existing.tool : 'external-agent',
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
