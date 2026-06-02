import type { Event } from '@monad/protocol';

import { parseEventPayload } from '@monad/protocol';

export interface InlineTurnResult {
  finalText: string;
  streamed: string;
  errorMessage?: string;
}

/**
 * Drive one inline agent turn and collect its text. `run` receives the event sink to hand to
 * `session.sendInline`; `onToken` (optional) fires on each accumulated token so a caller can stream
 * progress (e.g. A2A status-updates). Returns the final message text, the accumulated token stream
 * (fallback when no terminal snapshot arrives), and any error message. Shared by the A2A executor
 * and the Monadix task runner so the delta/completion/failure capture rule lives in one place.
 */
export async function collectInlineTurn(
  run: (sink: (event: Event) => void) => Promise<void>,
  onToken?: (streamed: string) => void
): Promise<InlineTurnResult> {
  let finalText = '';
  let streamed = '';
  let errorMessage: string | undefined;
  const deltaIndices = new Map<string, number>();
  const terminalMessageIds = new Set<string>();
  const sink = (event: Event): void => {
    if (event.type === 'session.message.delta.appended') {
      const payload = parseEventPayload('session.message.delta.appended', event.payload);
      if (payload.channel === 'reasoning') return;
      if ((deltaIndices.get(payload.messageId) ?? -1) >= payload.index) return;
      deltaIndices.set(payload.messageId, payload.index);
      streamed += payload.delta;
      onToken?.(streamed);
    } else if (event.type === 'session.message.completed') {
      const { message } = parseEventPayload('session.message.completed', event.payload);
      if (message.role === 'assistant' && !terminalMessageIds.has(message.id)) {
        terminalMessageIds.add(message.id);
        finalText = message.text;
      }
    } else if (event.type === 'session.message.failed') {
      const { message } = parseEventPayload('session.message.failed', event.payload);
      if (message.role === 'assistant' && !terminalMessageIds.has(message.id)) {
        terminalMessageIds.add(message.id);
        errorMessage = message.text;
      }
    }
  };
  await run(sink);
  return { finalText, streamed, errorMessage };
}
