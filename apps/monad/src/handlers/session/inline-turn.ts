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
 * (fallback when no discrete `agent.message` arrives), and any error message. Shared by the A2A
 * executor and the Monadix task runner so the token/message/error capture rule lives in one place.
 */
export async function collectInlineTurn(
  run: (sink: (event: Event) => void) => Promise<void>,
  onToken?: (streamed: string) => void
): Promise<InlineTurnResult> {
  let finalText = '';
  let streamed = '';
  let errorMessage: string | undefined;
  const sink = (event: Event): void => {
    if (event.type === 'agent.token') {
      streamed += parseEventPayload('agent.token', event.payload).delta;
      onToken?.(streamed);
    } else if (event.type === 'agent.message') {
      finalText = parseEventPayload('agent.message', event.payload).text;
    } else if (event.type === 'agent.error') {
      errorMessage = parseEventPayload('agent.error', event.payload).message;
    }
  };
  await run(sink);
  return { finalText, streamed, errorMessage };
}
