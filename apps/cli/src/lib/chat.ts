import type { MonadClient } from '@monad/client';
import type { Event, SessionId } from '@monad/protocol';

import { parseEventPayload } from '@monad/protocol';

import { cyan } from './output.ts';

/** Stream a turn's reply token-by-token to stdout. Shared by `session send` and top-level `chat`.
 *  One round-trip: POST the turn and consume this round's events inline from the SSE body.
 *  Pass `signal` to stop rendering early (Ctrl-C). */
export async function streamReply(
  client: MonadClient,
  sessionId: SessionId,
  text: string,
  signal?: AbortSignal
): Promise<void> {
  let started = false;
  await client.sendStreamable(
    sessionId,
    text,
    (event: Event) => {
      if (event.type === 'agent.token') {
        if (!started) {
          process.stdout.write(cyan('monad ▸ '));
          started = true;
        }
        process.stdout.write(parseEventPayload('agent.token', event.payload).delta);
      } else if (event.type === 'agent.message') {
        if (!started) process.stdout.write(cyan('monad ▸ ') + parseEventPayload('agent.message', event.payload).text);
        process.stdout.write('\n');
      }
    },
    signal
  );
}

/** Resolve message text from args, reading stdin when the text is `-` (or absent on a pipe). */
export async function resolveText(rest: string[]): Promise<string> {
  const joined = rest.join(' ').trim();
  if (joined === '-' || (joined === '' && !process.stdin.isTTY)) {
    return (await Bun.stdin.text()).trim();
  }
  return joined;
}
