import type { WorkplaceExperienceActions } from '../../src/runtime.ts';

import { expect, test } from 'bun:test';

import { isWorkplaceExperienceApiCompatible, WORKPLACE_EXPERIENCE_API_VERSION } from '../../src/index.ts';

test('workplace experience rename advances the host API major version', () => {
  expect(WORKPLACE_EXPERIENCE_API_VERSION).toBe(2);
  expect(isWorkplaceExperienceApiCompatible(1)).toBe(false);
  expect(isWorkplaceExperienceApiCompatible(2)).toBe(true);
});

test('workplace experience actions may open a project session', () => {
  const openedSessionIds: string[] = [];
  const openProjectSession = (sessionId: string): void => {
    openedSessionIds.push(sessionId);
  };
  const action: Pick<WorkplaceExperienceActions, 'openProjectSession'> = { openProjectSession };

  action.openProjectSession?.('ses_a');
  expect(openedSessionIds).toEqual(['ses_a']);
});
