import { expect, test } from 'bun:test';

import { isChatExperienceReady } from '../../src/features/workplace/chat-experience-readiness.ts';

test('chat experience becomes ready only after the lists needed to decide emptiness finish loading', () => {
  expect([
    isChatExperienceReady({
      activeProjectId: null,
      activeSessionId: null,
      projectSessionsLoading: false,
      streamLoading: false
    }),
    isChatExperienceReady({
      activeProjectId: 'prj_1',
      activeSessionId: null,
      projectSessionsLoading: true,
      streamLoading: false
    }),
    isChatExperienceReady({
      activeProjectId: 'prj_1',
      activeSessionId: 'ses_1',
      projectSessionsLoading: false,
      streamLoading: true
    }),
    isChatExperienceReady({
      activeProjectId: 'prj_1',
      activeSessionId: null,
      projectSessionsLoading: false,
      streamLoading: false
    }),
    isChatExperienceReady({
      activeProjectId: 'prj_1',
      activeSessionId: 'ses_1',
      projectSessionsLoading: false,
      streamLoading: false,
      streamSnapshotReceived: false
    }),
    isChatExperienceReady({
      activeProjectId: 'prj_1',
      activeSessionId: 'ses_1',
      projectSessionsLoading: false,
      streamLoading: false,
      streamSnapshotReceived: true
    })
  ]).toEqual([false, false, false, true, false, true]);
});
