import type { Event, SessionUiEvent, UIApprovalDisplay } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { parseEventPayload, uiApprovalDisplaySchema } from '@monad/protocol';

function approvalDisplayHint(input: unknown): UIApprovalDisplay | undefined {
  const parsed = uiApprovalDisplaySchema.safeParse((input as { displayHint?: unknown } | undefined)?.displayHint);
  return parsed.success ? parsed.data : undefined;
}

function approvalDisplay(tool: string, input: unknown, key?: string): UIApprovalDisplay | undefined {
  if (tool === 'path_access') {
    const hint = approvalDisplayHint(input);
    if (hint?.kind === 'resource-approval' && hint.resource === 'path') return hint;
    const dir = typeof (input as { dir?: unknown })?.dir === 'string' ? (input as { dir: string }).dir : key;
    return {
      kind: 'resource-approval',
      resource: 'path',
      ...(dir ? { subject: dir } : {})
    };
  }
  if (tool === 'network_access') {
    const hint = approvalDisplayHint(input);
    if (hint?.kind === 'resource-approval' && hint.resource === 'network') return hint;
    const host = typeof (input as { host?: unknown })?.host === 'string' ? (input as { host: string }).host : key;
    return {
      kind: 'resource-approval',
      resource: 'network',
      ...(host ? { subject: host } : {})
    };
  }
  return undefined;
}

export function applyInteractionEvent(m: ProjectionMutations, event: Event): SessionUiEvent[] | undefined {
  switch (event.type) {
    case 'tool.approval_requested': {
      const p = parseEventPayload('tool.approval_requested', event.payload);
      const display = approvalDisplay(p.tool, p.input, p.key);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'approval',
            id: p.requestId,
            tool: p.tool,
            ...(p.input !== undefined ? { input: p.input } : {}),
            ...(display !== undefined ? { display } : {}),
            ...(p.key ? { key: p.key } : {}),
            seq: event.id
          })
        }
      ];
    }
    case 'tool.approval_resolved': {
      const p = parseEventPayload('tool.approval_resolved', event.payload);
      return [m.remove('approval', p.requestId)];
    }
    case 'clarify.requested': {
      const p = parseEventPayload('clarify.requested', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'clarification',
            id: p.requestId,
            question: p.question,
            ...(p.options ? { options: p.options } : {}),
            ...(p.mode ? { mode: p.mode } : {}),
            ...(p.allowOther !== undefined ? { allowOther: p.allowOther } : {}),
            ...(p.asker ? { asker: p.asker } : {}),
            seq: event.id
          })
        }
      ];
    }
    case 'clarify.resolved': {
      const p = parseEventPayload('clarify.resolved', event.payload);
      return [m.remove('clarification', p.requestId)];
    }
    case 'context.usage': {
      const p = parseEventPayload('context.usage', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'context',
            id: 'context',
            usage: p,
            seq: event.id
          })
        }
      ];
    }
    case 'context.evicted': {
      const p = parseEventPayload('context.evicted', event.payload);
      const resultWord = p.resultCount === 1 ? 'result' : 'results';
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'system',
            id: event.id,
            text: `Cleared ~${p.reclaimedTokens.toLocaleString()} tokens (${p.resultCount} tool ${resultWord}) from context.`,
            level: 'info',
            seq: event.id
          })
        }
      ];
    }
    case 'context.handoff_suggested': {
      const p = parseEventPayload('context.handoff_suggested', event.payload);
      return [
        {
          kind: 'upsert',
          cursor: event.id,
          item: m.upsert({
            kind: 'system',
            id: event.id,
            text: `Context is ${Math.round(p.usedFraction * 100)}% full — consider starting a fresh session.`,
            level: 'warn',
            seq: event.id
          })
        }
      ];
    }
    case 'memory.suggestion': {
      const p = parseEventPayload('memory.suggestion', event.payload);
      return [m.setCustom({ id: event.id, name: event.type, data: p, status: 'streaming', seq: event.id })];
    }
    case 'session.updated': {
      const p = parseEventPayload('session.updated', event.payload);
      return p.reset ? [m.clearItems()] : [];
    }
    case 'task.created': {
      const p = parseEventPayload('task.created', event.payload);
      return [m.setCustom({ id: p.taskId, name: event.type, data: p, status: 'streaming', seq: event.id })];
    }
    case 'task.progress': {
      const p = parseEventPayload('task.progress', event.payload);
      return [m.setCustom({ id: p.taskId, name: event.type, data: p, status: 'streaming', seq: event.id })];
    }
    case 'task.completed': {
      const p = parseEventPayload('task.completed', event.payload);
      return [m.setCustom({ id: p.taskId, name: event.type, data: p, status: 'done', seq: event.id })];
    }
    case 'task.failed': {
      const p = parseEventPayload('task.failed', event.payload);
      return [m.setCustom({ id: p.taskId, name: event.type, data: p, status: 'error', seq: event.id })];
    }
    case 'delegation.fs_request': {
      const p = parseEventPayload('delegation.fs_request', event.payload);
      return [m.setCustom({ id: p.requestId, name: event.type, data: p, status: 'streaming', seq: event.id })];
    }
    case 'delegation.terminal_request': {
      const p = parseEventPayload('delegation.terminal_request', event.payload);
      return [m.setCustom({ id: p.requestId, name: event.type, data: p, status: 'streaming', seq: event.id })];
    }
    default:
      return undefined;
  }
}
