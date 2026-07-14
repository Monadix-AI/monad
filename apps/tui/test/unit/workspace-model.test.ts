import { describe, expect, test } from 'bun:test';

import {
  addProjectMemberTemplate,
  chatAgentLabel,
  chatCreateRequest,
  confirmDestructive,
  inboxOpenTarget,
  plainChatSessions,
  projectCreateRequest,
  projectSessionCreateRequest,
  projectUpdateRequest,
  removeProjectMemberTemplate
} from '../../src/shell/workspace-model.ts';

describe('Chat Web model', () => {
  const agents = [
    { id: 'agt_alpha', name: 'Alpha' },
    { id: 'agt_beta', name: 'Beta' }
  ];

  test('omits agentId for Default Agent and includes an explicit Agent', () => {
    expect(chatCreateRequest('New chat', null)).toEqual({ title: 'New chat' });
    expect(chatCreateRequest('New chat', 'agt_alpha' as never)).toEqual({ agentId: 'agt_alpha', title: 'New chat' });
  });

  test('labels default, configured, and stale Agent bindings', () => {
    expect(chatAgentLabel([], agents as never)).toBe('Default Agent');
    expect(chatAgentLabel(['agt_beta'] as never, agents as never)).toBe('Beta');
    expect(chatAgentLabel(['agt_missing'] as never, agents as never)).toBe('Unavailable Agent');
  });

  test('keeps Workplace Project sessions out of the plain Chats surface', () => {
    const sessions = [
      { id: 'ses_chat', projectId: null },
      { id: 'ses_project', projectId: 'prj_demo' },
      { id: 'ses_legacy' }
    ];

    expect(plainChatSessions(sessions)).toEqual([{ id: 'ses_chat', projectId: null }, { id: 'ses_legacy' }]);
  });
});

test('Inbox open targets retain Workplace Project routing context', () => {
  expect(inboxOpenTarget({ projectId: 'prj_demo' as never, sessionId: 'ses_project' as never })).toEqual({
    projectId: 'prj_demo',
    sessionId: 'ses_project'
  });
  expect(inboxOpenTarget({ sessionId: 'ses_chat' as never })).toEqual({
    projectId: null,
    sessionId: 'ses_chat'
  });
});

test('destructive confirmation requires the same selected entity twice', () => {
  expect(confirmDestructive(null, 'one')).toEqual({ armedId: 'one', confirmed: false });
  expect(confirmDestructive('one', 'two')).toEqual({ armedId: 'two', confirmed: false });
  expect(confirmDestructive('one', 'one')).toEqual({ armedId: null, confirmed: true });
});

describe('Workplace Project Web model', () => {
  test('creates a Project from a required name and optional trimmed cwd', () => {
    expect(projectCreateRequest('  Demo  ', '  /repo/demo  ')).toEqual({ cwd: '/repo/demo', title: 'Demo' });
    expect(projectCreateRequest('Demo', '   ')).toEqual({ title: 'Demo' });
    expect(projectCreateRequest('   ', '/repo')).toBeNull();
  });

  test('maps editable Project fields without conflating empty cwd with omission', () => {
    expect(projectUpdateRequest('title', '  Renamed  ')).toEqual({ title: 'Renamed' });
    expect(projectUpdateRequest('cwd', '   ')).toEqual({ cwd: null });
    expect(projectUpdateRequest('archived', true)).toEqual({ archived: true });
  });

  test('creates Project sessions without a per-session Agent binding', () => {
    const request = projectSessionCreateRequest('  Investigation  ');
    expect(request).toEqual({ title: 'Investigation' });
    expect(request && 'agentId' in request).toBe(false);
  });
});

describe('Project member templates', () => {
  test('deduplicates Monad and ACP templates without replacing advanced settings', () => {
    const existing = [
      { id: 'acp:codex', type: 'acp' as const, name: 'codex', settings: { cwd: '/repo', osSandbox: true } }
    ];

    expect(addProjectMemberTemplate(existing, { name: 'codex', type: 'acp' }).members).toEqual(existing);
    expect(addProjectMemberTemplate([], { name: 'monad', type: 'monad' }).members).toEqual([
      { id: 'monad', name: 'monad', type: 'monad' }
    ]);
  });

  test('allows multiple External Agent instances with unique identities', () => {
    const first = addProjectMemberTemplate([], {
      name: 'codex-cli',
      productIcon: 'codex',
      provider: 'codex',
      type: 'external-agent'
    }).members;
    const second = addProjectMemberTemplate(first, {
      name: 'codex-cli',
      productIcon: 'codex',
      provider: 'codex',
      type: 'external-agent'
    }).members;

    expect(second).toHaveLength(2);
    expect(second[0]?.id).not.toBe(second[1]?.id);
    expect(second.map((member) => member.displayName)).toEqual(['OpenAI Codex', 'OpenAI Codex-2']);
  });

  test('removes only the selected member template', () => {
    const members = [
      { id: 'monad', type: 'monad' as const, name: 'monad' },
      { id: 'acp:codex', type: 'acp' as const, name: 'codex' }
    ];
    expect(removeProjectMemberTemplate(members, 'monad')).toEqual([{ id: 'acp:codex', type: 'acp', name: 'codex' }]);
  });
});
