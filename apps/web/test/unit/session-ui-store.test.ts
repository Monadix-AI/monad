import { expect, test } from 'bun:test';

import { useSessionUiStore } from '../../src/features/session/session-ui-store.ts';

test('applyCommandInsert replaces the active token when a range is provided', () => {
  useSessionUiStore.setState({ input: '/me' });
  useSessionUiStore.getState().applyCommandInsert({
    insert: '/memory ',
    replace: { start: 0, end: 3 }
  });
  expect(useSessionUiStore.getState().input).toBe('/memory ');
});

test('applyCommandInsert keeps append behavior for items without a replacement range', () => {
  useSessionUiStore.setState({ input: 'hello ' });
  useSessionUiStore.getState().applyCommandInsert({ insert: '/skill ' });
  expect(useSessionUiStore.getState().input).toBe('hello /skill ');
});

test('applyCommandInsert replaces a partially typed subcommand', () => {
  useSessionUiStore.setState({ input: '/memory c' });
  useSessionUiStore.getState().applyCommandInsert({
    insert: '/memory check ',
    replace: { start: 0, end: 9 }
  });
  expect(useSessionUiStore.getState().input).toBe('/memory check ');
});

test('applyCommandInsert replaces a partially typed subcommand argument', () => {
  useSessionUiStore.setState({ input: '/memory consolidate 3' });
  useSessionUiStore.getState().applyCommandInsert({
    insert: '/memory consolidate 1',
    replace: { start: 0, end: 21 }
  });
  expect(useSessionUiStore.getState().input).toBe('/memory consolidate 1');
});
