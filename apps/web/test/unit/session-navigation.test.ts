import { expect, test } from 'bun:test';

import { shouldResetMissingSessionRoute } from '../../src/features/shell/routing/navigation.ts';

test('a branched session route is retained while the sessions list refetches', () => {
  expect(
    shouldResetMissingSessionRoute({
      currentId: 'ses_child0000000',
      isDraftSession: false,
      sessionExists: false,
      sessionsFetching: true,
      sessionsLoading: false
    })
  ).toBe(false);
});

test('a missing non-draft session route resets after session loading settles', () => {
  expect(
    shouldResetMissingSessionRoute({
      currentId: 'ses_missing000000',
      isDraftSession: false,
      sessionExists: false,
      sessionsFetching: false,
      sessionsLoading: false
    })
  ).toBe(true);
  expect(
    shouldResetMissingSessionRoute({
      currentId: 'ses_child0000000',
      isDraftSession: false,
      sessionExists: true,
      sessionsFetching: false,
      sessionsLoading: false
    })
  ).toBe(false);
});

test('a deleted archived preview keeps its missing session route', () => {
  expect(
    shouldResetMissingSessionRoute({
      currentId: 'ses_archived00000',
      isDraftSession: false,
      preserveMissingSessionRoute: true,
      sessionExists: false,
      sessionsFetching: false,
      sessionsLoading: false
    })
  ).toBe(false);
});
