import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { RoundCache } from '@/services/round-cache.ts';

function evt(transcriptTargetId: SessionId): Event {
  return {
    id: newId('evt'),
    transcriptTargetId,
    type: 'agent.token',
    actorAgentId: null,
    payload: {},
    at: new Date().toISOString()
  };
}

test('since() replays buffered events after the cursor, retire() clears them', () => {
  const cache = new RoundCache();
  const sessionId = newId('ses') as SessionId;
  const a = evt(sessionId);
  const b = evt(sessionId);
  const c = evt(sessionId);
  cache.append(a);
  cache.append(b);
  cache.append(c);

  // no cursor → full buffer
  expect(cache.since(sessionId).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  // cursor → only newer
  expect(cache.since(sessionId, a.id).map((e) => e.id)).toEqual([b.id, c.id]);

  cache.retire(sessionId);
  expect(cache.since(sessionId)).toEqual([]);
});

test('since() on an unknown session returns empty (falls back to durable log)', () => {
  const cache = new RoundCache();
  expect(cache.since(newId('ses') as SessionId, newId('evt'))).toEqual([]);
});
