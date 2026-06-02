import type { MeshAgentObservationEvent } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';

import { toFallbackAgentObservationEvent } from '../../src/agent-observation.ts';

function fixtureEvent(over: Partial<MeshAgentObservationEvent> = {}): MeshAgentObservationEvent {
  return {
    id: 'evt-1',
    role: 'agent',
    text: 'hello',
    source: 'plain-text',
    provenance: { rawEvents: [{ text: 'hello' }] },
    ...over
  };
}

describe('toFallbackAgentObservationEvent dedupeKey', () => {
  test('respects an adapter-supplied dedupeKey over the synthesized one', () => {
    const event = fixtureEvent({ dedupeKey: 'adapter-key' });
    const decoded = toFallbackAgentObservationEvent(event);
    expect(decoded?.dedupeKey).toBe('adapter-key');
  });

  test('synthesizes a stable dedupeKey from source + raw provenance content when the adapter omits one', () => {
    const eventFromPage = fixtureEvent({ id: 'page:0' });
    const eventFromLive = fixtureEvent({ id: 'live:9' });

    const fromPage = toFallbackAgentObservationEvent(eventFromPage);
    const fromLive = toFallbackAgentObservationEvent(eventFromLive);

    // Same underlying raw content reached through two different windows (a page projection vs. the
    // live tail) must produce the same dedupeKey, even though the positional `id` differs — this is
    // the join key `observationJoinKey` in the experience layer relies on to avoid duplicate rows.
    expect(fromPage?.dedupeKey).toBe(fromLive?.dedupeKey);
    expect(fromPage?.dedupeKey).toMatch(/^plain-text:[0-9a-f]{8}:agent$/);
  });

  test('synthesizes different dedupeKeys for events with different raw content', () => {
    const first = toFallbackAgentObservationEvent(fixtureEvent({ provenance: { rawEvents: [{ text: 'a' }] } }));
    const second = toFallbackAgentObservationEvent(fixtureEvent({ provenance: { rawEvents: [{ text: 'b' }] } }));
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey);
  });

  test('synthesizes different dedupeKeys for two events sharing the same raw record but different role/providerEventType', () => {
    // A single raw record can decode into more than one event (e.g. a reasoning event followed by a
    // tool-call event both citing the record that triggered them) — content hash alone would collide.
    const sharedRaw = { text: 'shared' };
    const reasoning = toFallbackAgentObservationEvent(
      fixtureEvent({ role: 'agent', providerEventType: 'reasoning', provenance: { rawEvents: [sharedRaw] } })
    );
    const toolCall = toFallbackAgentObservationEvent(
      fixtureEvent({ role: 'tool', providerEventType: 'tool_call', provenance: { rawEvents: [sharedRaw] } })
    );
    expect(reasoning?.dedupeKey).not.toBe(toolCall?.dedupeKey);
  });

  test('does not synthesize a callId for tool events (no adapter-independent way to correlate call/result)', () => {
    const event = fixtureEvent({ role: 'tool', text: 'ran', provenance: { rawEvents: [{ tool: 'ls' }] } });
    expect(toFallbackAgentObservationEvent(event)).toEqual({
      id: 'evt-1',
      dedupeKey: 'plain-text:ae65f06c:tool',
      kind: 'tool-result',
      streaming: false,
      provenance: { contractEvents: [event] },
      tool: { name: 'tool', output: 'ran' },
      text: 'ran'
    });
  });
});
