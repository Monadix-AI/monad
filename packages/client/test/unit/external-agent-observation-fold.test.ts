import type { ExternalAgentObservationAccessResponse } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX } from '@monad/protocol';

import { createExternalAgentObservationFolder } from '../../src/external-agent-observation-fold.ts';

function live(fields: { output?: string; append?: string; seq?: number }): ExternalAgentObservationAccessResponse {
  return {
    state: 'live',
    externalAgentSessionId: 'exa_test',
    provider: 'codex',
    observedAt: '2026-07-04T00:00:00.000Z',
    ...fields
  };
}

function collect(): {
  push: (a: ExternalAgentObservationAccessResponse) => void;
  frames: ExternalAgentObservationAccessResponse[];
} {
  const frames: ExternalAgentObservationAccessResponse[] = [];
  return { push: (a) => frames.push(a), frames };
}

test('full output snapshot passes through and sets the cursor', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  fold(live({ output: 'hello', seq: 5 }));
  expect(frames[0]).toMatchObject({ output: 'hello', seq: 5, append: undefined });
});

test('append deltas accumulate into a full output', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  fold(live({ output: 'ab', seq: 2 }));
  fold(live({ append: 'cd', seq: 4 }));
  fold(live({ append: 'ef', seq: 6 }));
  expect(frames.map((f) => (f.state === 'live' ? f.output : undefined))).toEqual(['ab', 'abcd', 'abcdef']);
  expect(frames.at(-1)).toMatchObject({ seq: 6, append: undefined });
});

test('an overlapping delta applies only the fresh tail past the cursor', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  fold(live({ output: 'abcd', seq: 4 }));
  // Delta says seq=6 with a 4-char append whose first 2 chars ('cd') overlap what we already have.
  fold(live({ append: 'cdef', seq: 6 }));
  expect(frames.at(-1)).toMatchObject({ output: 'abcdef', seq: 6 });
});

test('a stale/duplicate delta adds nothing and never rewinds the cursor', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  fold(live({ output: 'abcdef', seq: 6 }));
  fold(live({ append: 'cd', seq: 4 })); // seq <= cursor → already seen
  expect(frames.at(-1)).toMatchObject({ output: 'abcdef', seq: 6 });
});

test('a full output mid-stream resyncs and replaces the accumulator', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  fold(live({ append: 'garbage', seq: 7 }));
  fold(live({ output: 'clean', seq: 5 }));
  fold(live({ append: 'ed', seq: 7 }));
  expect(frames.at(-1)).toMatchObject({ output: 'cleaned', seq: 7 });
});

test('the accumulator is bounded but the cursor keeps the true cumulative seq', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  fold(live({ output: 'x'.repeat(EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX), seq: EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX }));
  const nextSeq = EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX + 3;
  fold(live({ append: 'yyy', seq: nextSeq }));
  const last = frames.at(-1);
  const output = last?.state === 'live' && typeof last.output === 'string' ? last.output : '';
  expect(output.length).toBe(EXTERNAL_AGENT_OUTPUT_SNAPSHOT_MAX);
  expect(output.endsWith('yyy')).toBe(true);
  expect(last).toMatchObject({ seq: nextSeq }); // cursor tracks cumulative length, not the bounded tail
});

test('append without an explicit seq falls back to cursor + length', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  fold(live({ output: 'ab', seq: 2 }));
  fold(live({ append: 'cd' }));
  expect(frames.at(-1)).toMatchObject({ output: 'abcd', seq: 4 });
});

test('non-live frames pass through untouched', () => {
  const { push, frames } = collect();
  const fold = createExternalAgentObservationFolder(push);
  const unavailable: ExternalAgentObservationAccessResponse = {
    state: 'unavailable',
    externalAgentSessionId: 'exa_test',
    reason: 'exited'
  };
  fold(unavailable);
  expect(frames[0]).toBe(unavailable);
});
