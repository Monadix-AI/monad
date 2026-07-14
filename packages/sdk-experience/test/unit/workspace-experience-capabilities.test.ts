import type { WorkspaceExperienceActions } from '../../src/runtime.ts';

import { expect, test } from 'bun:test';

test('workspace Experience actions may open a project session', () => {
  let openedSessionId: string | null = null;
  const openProjectSession = (sessionId: string): void => {
    openedSessionId = sessionId;
  };
  const action: Pick<WorkspaceExperienceActions, 'openProjectSession'> = { openProjectSession };

  action.openProjectSession?.('ses_a');
  expect(openedSessionId).toBe('ses_a');
});
