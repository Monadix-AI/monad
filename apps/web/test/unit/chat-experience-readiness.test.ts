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

test('an active session with a mesh-state subscription waits for the mesh snapshot too', () => {
  const base = {
    activeProjectId: 'prj_1',
    activeSessionId: 'ses_1',
    projectSessionsLoading: false,
    streamLoading: false,
    streamSnapshotReceived: true,
    meshStateSubscribed: true
  } as const;
  expect([
    isChatExperienceReady({ ...base, meshStateSnapshotReceived: false }),
    isChatExperienceReady({ ...base, meshStateSnapshotReceived: true }),
    isChatExperienceReady({
      activeProjectId: 'prj_1',
      activeSessionId: null,
      projectSessionsLoading: false,
      streamLoading: false,
      meshStateSubscribed: false,
      meshStateSnapshotReceived: false
    })
  ]).toEqual([false, true, true]);
});
