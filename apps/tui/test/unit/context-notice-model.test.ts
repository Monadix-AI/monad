import type { ContextNotice, MemorySuggestion } from '@monad/client-rtk';
import type { ContextUsagePayload } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { activeMemorySuggestion, latestHandoffNudge } from '../../src/shell/context-notice-model.ts';

const handoff = (id: string, usedFraction: number, atFraction = 0.8): ContextNotice => ({
  id,
  kind: 'handoff',
  usedFraction,
  atFraction
});
const evicted = (id: string): ContextNotice => ({ id, kind: 'evicted', reclaimedTokens: 1000, resultCount: 2 });
const usage = (used: number, contextLimit: number): ContextUsagePayload => ({
  contextLimit,
  used,
  free: contextLimit - used,
  autocompactBuffer: 0,
  approximate: false,
  segments: []
});

test('surfaces the newest handoff nudge, skipping evicted housekeeping', () => {
  expect(
    latestHandoffNudge([handoff('n1', 0.82), evicted('n2'), handoff('n3', 0.91), evicted('n4')], undefined)
  ).toEqual({
    id: 'n3',
    kind: 'handoff',
    usedFraction: 0.91,
    atFraction: 0.8
  });
});

test('evicted-only notices produce no nudge', () => {
  expect(latestHandoffNudge([evicted('n1')], usage(900, 1000))).toBeUndefined();
});

test('nudge clears once live usage falls back under the nudge fraction, and holds while still over', () => {
  const notices = [handoff('n1', 0.85)];
  expect(latestHandoffNudge(notices, usage(300, 1000))).toBeUndefined();
  expect(latestHandoffNudge(notices, usage(900, 1000))).toEqual({
    id: 'n1',
    kind: 'handoff',
    usedFraction: 0.85,
    atFraction: 0.8
  });
});

test('memory suggestion shows until handled, then stays hidden', () => {
  const suggestion: MemorySuggestion = { id: 's1', scope: { kind: 'agent', id: 'a1' }, facts: ['likes tea'] };
  expect(activeMemorySuggestion(suggestion, null)).toEqual({
    id: 's1',
    scope: { kind: 'agent', id: 'a1' },
    facts: ['likes tea']
  });
  expect(activeMemorySuggestion(suggestion, 's1')).toBeUndefined();
  expect(activeMemorySuggestion(undefined, null)).toBeUndefined();
});
