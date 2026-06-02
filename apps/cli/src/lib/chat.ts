import type { MonadClient } from '@monad/client';
import type { Event, SendMessageAttachment, SessionId } from '@monad/protocol';

import { parseEventPayload } from '@monad/protocol';

import { cyan } from './output.ts';

/** Stream a turn's reply token-by-token to stdout. Shared by `session send` and top-level `chat`.
 *  One round-trip: POST the turn and consume this round's events inline from the SSE body.
 *  Pass `signal` to stop rendering early (Ctrl-C). */
export async function streamReply(
  client: MonadClient,
  sessionId: SessionId,
  text: string,
  signal?: AbortSignal,
  attachments?: SendMessageAttachment[]
): Promise<void> {
  let activeMessageId: string | undefined;
  await client.sendStreamable(
    sessionId,
    text,
    (event: Event) => {
      if (event.type === 'session.message.delta.appended') {
        const payload = parseEventPayload('session.message.delta.appended', event.payload);
        if (payload.channel !== 'answer') return;
        if (!activeMessageId) {
          process.stdout.write(cyan('Monad ▸ '));
        }
        activeMessageId = payload.messageId;
        process.stdout.write(payload.delta);
      } else if (event.type === 'session.message.completed') {
        const { message } = parseEventPayload('session.message.completed', event.payload);
        if (activeMessageId !== message.id) process.stdout.write(cyan('Monad ▸ ') + message.text);
        process.stdout.write('\n');
        if (activeMessageId === message.id) activeMessageId = undefined;
      } else if (event.type === 'session.message.failed') {
        const { message } = parseEventPayload('session.message.failed', event.payload);
        if (activeMessageId === message.id) {
          process.stdout.write('\n');
          activeMessageId = undefined;
        }
      }
    },
    signal,
    attachments
  );
}

/** Resolve a secret-bearing payload from an argument, reading stdin when it is `-` — or when it is
 *  absent and stdin is a pipe, since a lone `-` can be swallowed by the argument parser. Passing a
 *  key as an argument exposes it through `ps` to every local user and records it in shell history. */
export async function resolvePayload(arg: string | undefined): Promise<string | undefined> {
  if (arg === '-' || (arg === undefined && !process.stdin.isTTY)) return (await Bun.stdin.text()).trim();
  return arg;
}

/** Resolve message text from args, reading stdin when the text is `-` (or absent on a pipe). */
export async function resolveText(rest: string[]): Promise<string> {
  const joined = rest.join(' ').trim();
  if (joined === '-' || (joined === '' && !process.stdin.isTTY)) {
    return (await Bun.stdin.text()).trim();
  }
  return joined;
}
