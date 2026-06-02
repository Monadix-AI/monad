import type { UIItem } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { classifyContextNotice } from '../../src/features/session/context-notice.ts';

const system = (over: Partial<Extract<UIItem, { kind: 'system' }>>): UIItem => ({
  kind: 'system',
  id: 'evt_1',
  text: 'Context is 85% full — consider starting a fresh session.',
  seq: 'evt_1',
  ...over
});

const custom = (over: Partial<Extract<UIItem, { kind: 'custom' }>>): UIItem => ({
  kind: 'custom',
  id: 'evt_2',
  name: 'memory.suggestion',
  seq: 'evt_2',
  ...over
});

test('a warn-level system notice becomes a toast carrying its text', () => {
  expect(classifyContextNotice(system({ level: 'warn' }))).toEqual({
    kind: 'toast',
    text: 'Context is 85% full — consider starting a fresh session.'
  });
});

test('an info-level system notice (context.evicted) is ignored — routine housekeeping', () => {
  expect(classifyContextNotice(system({ level: 'info', text: 'Cleared ~6,200 tokens.' }))).toBeNull();
});

test('a system notice with no level is ignored (only warn surfaces)', () => {
  expect(classifyContextNotice(system({}))).toBeNull();
});

test('a valid memory.suggestion becomes a suggestion carrying its scope and facts', () => {
  const notice = classifyContextNotice(
    custom({ data: { scope: { kind: 'agent', id: 'agt_100000000000' }, facts: ['User prefers dark mode'] } })
  );
  expect(notice).toEqual({
    kind: 'suggestion',
    scope: { kind: 'agent', id: 'agt_100000000000' },
    facts: ['User prefers dark mode']
  });
});

test('a memory.suggestion with an empty fact list is ignored (nothing to save)', () => {
  expect(classifyContextNotice(custom({ data: { scope: { kind: 'global', id: '*' }, facts: [] } }))).toBeNull();
});

test('a memory.suggestion missing its scope is ignored (malformed payload)', () => {
  expect(classifyContextNotice(custom({ data: { facts: ['x'] } }))).toBeNull();
});

test('a custom item that is not a memory.suggestion is ignored', () => {
  expect(
    classifyContextNotice(custom({ name: 'task.created', data: { scope: { kind: 'agent', id: 'a' }, facts: ['x'] } }))
  ).toBeNull();
});
