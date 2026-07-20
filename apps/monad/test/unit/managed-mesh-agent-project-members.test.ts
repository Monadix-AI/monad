import type { MeshAgentConfig } from '@monad/environment';
import type { Session, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';

import { managedMeshAgentProjectMembers } from '#/handlers/session/handlers/messaging-members.ts';
import { createStore } from '#/store/db/index.ts';

const codex = {
  name: 'codex',
  provider: 'codex',
  command: 'codex',
  enabled: true,
  allowAutopilot: false,
  approvalOwnership: 'provider-owned'
} satisfies MeshAgentConfig;

test('managed project members keep resolved and configured display names distinct', () => {
  const store = createStore();
  const now = new Date().toISOString();
  const session = {
    id: 'ses_membernames001' as SessionId,
    title: 'Workplace: Test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session;
  store.insertSession(session);
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_codex_default',
    templateId: 'pmem_codex_template',
    type: 'mesh-agent',
    data: {
      name: 'codex',
      instanceId: 'pmem_codex_default',
      settings: { managedProjectAgent: true }
    },
    createdAt: now,
    updatedAt: now
  });
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_codex_reviewer',
    templateId: 'pmem_codex_template',
    type: 'mesh-agent',
    data: {
      name: 'codex',
      displayName: 'Reviewer',
      instanceId: 'pmem_codex_reviewer',
      settings: { managedProjectAgent: true }
    },
    createdAt: now,
    updatedAt: now
  });

  try {
    expect(managedMeshAgentProjectMembers(store, session.id, [codex])).toEqual([
      {
        spec: codex,
        runtimeAgentName: 'pmem_codex_default',
        templateAgentName: 'codex',
        displayName: 'codex',
        configuredDisplayName: undefined,
        settings: { managedProjectAgent: true }
      },
      {
        spec: codex,
        runtimeAgentName: 'pmem_codex_reviewer',
        templateAgentName: 'codex',
        displayName: 'Reviewer',
        configuredDisplayName: 'Reviewer',
        settings: { managedProjectAgent: true }
      }
    ]);
  } finally {
    store.close();
  }
});

test('managed project members resolve mesh config from template id instead of member name', () => {
  const store = createStore();
  const now = new Date().toISOString();
  const session = {
    id: 'ses_membertemplate01' as SessionId,
    title: 'Workplace: Test',
    state: 'active',
    agentIds: [],
    archived: false,
    restoreCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    },
    costUsd: 0,
    cwd: process.cwd(),
    createdAt: now,
    updatedAt: now
  } satisfies Session;
  const claude = {
    name: 'claude-code',
    provider: 'claude-code',
    command: 'claude',
    enabled: true,
    allowAutopilot: true,
    approvalOwnership: 'provider-owned',
    projectTemplates: [{ id: 'tpl_claude_reviewer', displayName: 'Claude Reviewer' }]
  } satisfies MeshAgentConfig;
  store.insertSession(session);
  store.insertSessionMember({
    sessionId: session.id,
    memberId: 'pmem_claude_reviewer',
    templateId: 'tpl_claude_reviewer',
    type: 'mesh-agent',
    data: {
      name: 'Renamed reviewer',
      displayName: 'Reviewer',
      instanceId: 'pmem_claude_reviewer',
      settings: { managedProjectAgent: true }
    },
    createdAt: now,
    updatedAt: now
  });

  try {
    expect(managedMeshAgentProjectMembers(store, session.id, [claude])).toEqual([
      {
        spec: claude,
        runtimeAgentName: 'pmem_claude_reviewer',
        templateAgentName: 'claude-code',
        displayName: 'Reviewer',
        configuredDisplayName: 'Reviewer',
        settings: { managedProjectAgent: true }
      }
    ]);
  } finally {
    store.close();
  }
});
