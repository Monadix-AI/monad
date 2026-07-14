import type { WorkspaceExperienceActions } from '../../src/runtime.ts';

import { expect, test } from 'bun:test';

test('workspace Experience actions may open a project session', () => {
  const openedSessionIds: string[] = [];
  const openProjectSession = (sessionId: string): void => {
    openedSessionIds.push(sessionId);
  };
  const action: Pick<WorkspaceExperienceActions, 'openProjectSession'> = { openProjectSession };

  action.openProjectSession?.('ses_a');
  expect(openedSessionIds).toEqual(['ses_a']);
});
