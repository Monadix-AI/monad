import type { Event, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { RoundCache } from '#/services/round-cache.ts';

function evt(sessionId: SessionId): Event {
  return {
    id: newId('evt'),
    sessionId,
    type: 'session.message.delta.appended',
    actorAgentId: null,
    payload: {
      transcriptTargetId: sessionId,
      producer: { kind: 'agent', agentId: 'agt_100000000000' },
      messageId: 'msg_100000000000',
      channel: 'answer',
      index: 0,
      delta: 'x'
    },
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
  expect(cache.anchorStatus(sessionId, a.id)).toBe('live');
  expect(cache.eventsAfterKnownAnchor(sessionId, a.id).map((e) => e.id)).toEqual([b.id, c.id]);

  cache.retire(sessionId);
  expect(cache.anchorStatus(sessionId, a.id)).toBe('missing');
});

test('unknown and wrong-session anchors are not treated as fresh buffer requests', () => {
  const cache = new RoundCache();
  const sessionId = newId('ses') as SessionId;
  const otherSessionId = newId('ses') as SessionId;
  const event = evt(otherSessionId);
  cache.append(event);
  expect(cache.anchorStatus(sessionId, event.id)).toBe('other_scope');
  expect(cache.anchorStatus(sessionId, newId('evt'))).toBe('missing');
  expect(cache.since(sessionId, event.id)).toEqual([]);
  expect(cache.since(otherSessionId, newId('evt'))).toEqual([]);
});
