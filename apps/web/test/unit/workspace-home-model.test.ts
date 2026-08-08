import { describe, expect, test } from 'bun:test';

import {
  resolveWorkspaceLaunchTarget,
  workspaceLaunchErrorMessage,
  workspaceSessionTitleFromDraft,
  workspaceSetupActions
} from '../../src/features/workspace/workspace-home-model.ts';

describe('resolveWorkspaceLaunchTarget', () => {
  test('uses a fresh Monad Agent session when no existing session is selected', () => {
    expect(
      resolveWorkspaceLaunchTarget({
        mode: 'agent',
        selectedAgentSessionId: null,
        selectedProjectId: null
      })
    ).toEqual({ kind: 'new-agent' });
  });

  test('opens the selected existing Monad Agent session', () => {
    expect(
      resolveWorkspaceLaunchTarget({
        mode: 'agent',
        selectedAgentSessionId: 'ses_EXISTING0000',
        selectedProjectId: null
      })
    ).toEqual({ kind: 'existing-agent', sessionId: 'ses_EXISTING0000' });
  });

  test('creates a session in the selected project', () => {
    expect(
      resolveWorkspaceLaunchTarget({
        mode: 'project',
        selectedAgentSessionId: null,
        selectedProjectId: 'prj_SELECTED0000'
      })
    ).toEqual({ kind: 'project', projectId: 'prj_SELECTED0000' });
  });

  test('requires a project selection in project mode', () => {
    expect(
      resolveWorkspaceLaunchTarget({
        mode: 'project',
        selectedAgentSessionId: null,
        selectedProjectId: null
      })
    ).toBeNull();
  });
});

describe('workspaceSetupActions', () => {
  test('routes each missing setup requirement to its Studio section', () => {
    expect({
      bothMissing: workspaceSetupActions({ meshAgentConnected: false, profileConfigured: false }),
      meshMissing: workspaceSetupActions({ meshAgentConnected: false, profileConfigured: true }),
      profileMissing: workspaceSetupActions({ meshAgentConnected: true, profileConfigured: false }),
      ready: workspaceSetupActions({ meshAgentConnected: true, profileConfigured: true })
    }).toEqual({
      bothMissing: [
        { href: '/studio/models', id: 'profile' },
        { href: '/studio/meshAgents', id: 'mesh-agent' }
      ],
      meshMissing: [{ href: '/studio/meshAgents', id: 'mesh-agent' }],
      profileMissing: [{ href: '/studio/models', id: 'profile' }],
      ready: []
    });
  });
});

describe('workspaceSessionTitleFromDraft', () => {
  test('uses a trimmed draft capped to session title length', () => {
    expect(workspaceSessionTitleFromDraft(`  ${'x'.repeat(90)}  `)).toBe('x'.repeat(72));
  });

  test('falls back when the draft is empty', () => {
    expect(workspaceSessionTitleFromDraft('   ', 'Fallback title')).toBe('Fallback title');
  });
});

describe('workspaceLaunchErrorMessage', () => {
  test('uses the daemon response message when available', () => {
    expect(workspaceLaunchErrorMessage({ data: { message: 'The session could not be created.' } })).toBe(
      'The session could not be created.'
    );
  });

  test('uses an Error message before falling back', () => {
    expect(workspaceLaunchErrorMessage(new Error('Connection lost'))).toBe('Connection lost');
    expect(workspaceLaunchErrorMessage({ status: 500 })).toBeNull();
  });
});
