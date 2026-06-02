import type { Event, SessionUiEvent, UIItem } from '@monad/protocol';
import type { ProjectionMutations } from './ui-projection-state.ts';

import { parseEventPayload } from '@monad/protocol';

import { isUnknownToolResult, itemKey } from './ui-projection-helpers.ts';

function settleBuiltInStreamingMessages(m: ProjectionMutations): SessionUiEvent[] {
  const settled: SessionUiEvent[] = [];
  for (const item of m.items.values()) {
    if (item.kind !== 'message' || item.role !== 'assistant' || item.status !== 'streaming' || item.source) continue;
    m.rawStreamingText.delete(item.id);
    m.channelDisplayCache.delete(item.id);
    const hasVisibleContent = item.parts.some(
      (part) => part.type !== 'reasoning' && (part.type !== 'text' || part.text.trim() !== '')
    );
    if (hasVisibleContent) {
      settled.push(m.setMessage({ ...item, status: 'done' }));
      continue;
    }
    m.toolIntermediateMessageIds.add(item.id);
    settled.push(m.remove('message', item.id));
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
            seq: event.at
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
        seq: existing?.kind === 'tool' ? existing.seq : event.at
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
        seq: existing?.kind === 'tool' ? existing.seq : event.at
      };
      return [{ kind: 'upsert', cursor: event.id, item: m.upsert(next) }];
    }
    default:
      return undefined;
  }
}
