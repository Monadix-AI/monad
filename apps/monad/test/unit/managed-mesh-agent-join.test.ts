import type { MeshAgentConfig } from '@monad/environment';
import type { MeshSessionView, Session } from '@monad/protocol';
import type { SessionContext } from '#/handlers/session/context.ts';
import type { ManagedMeshAgentProjectMember } from '#/handlers/session/handlers/messaging-members.ts';

import { expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManagedMeshAgentJoin } from '#/handlers/session/handlers/managed-mesh-agent-join.ts';

test('session-only member starts in the project shared workspace when the session has no cwd', async () => {
  const monadHome = await mkdtemp(join(tmpdir(), 'monad-managed-join-'));
  const workingPaths: string[] = [];
  const startedMessages: string[] = [];
  const lifecycle: string[] = [];
  const meshAgentHost = {
    list: () => ({ sessions: [] }),
    preflight: async () => ({ state: 'ready' as const }),
    start: async (args: {
      agentName: string;
      workingPath: string;
      beforeInitialTurn?: (meshSessionId: string) => Promise<void>;
    }) => {
      workingPaths.push(args.workingPath);
      lifecycle.push('runtime-owned');
      await args.beforeInitialTurn?.('mesh_join00000000');
      lifecycle.push('initial-turn-opened');
      return { id: 'mesh_join00000000', agentName: args.agentName } as unknown as MeshSessionView;
    }
  };
  const ctx = {
    deps: {
      store: {
        findManagedMeshAgentStreamingMessage: () => undefined
      },
      paths: { home: monadHome },
      meshAgentHost,
      hookCwd: tmpdir()
    },
    emitLifecycle: () => {},
    requireSession: () => ({
      id: 'ses_join00000000',
      projectId: 'prj_join00000000',
      cwd: undefined
    }),
    makeEmit: () => () => {},
    persistAndRetire: () => {},
    messageIngress: {
      begin: async () => {
        startedMessages.push('started');
        lifecycle.push('placeholder-reserved');
        return { id: 'msg_join00000000' };
      },
      deliver: async () => {
        throw new Error('unexpected join error');
      }
    }
  } as unknown as SessionContext;
  const session = {
    id: 'ses_join00000000',
    projectId: 'prj_join00000000',
    cwd: undefined
  } as unknown as Session;
  const member: ManagedMeshAgentProjectMember = {
    spec: { name: 'codex', provider: 'codex' } as MeshAgentConfig,
    projectMemberId: 'pmem_join000000',
    runtimeAgentName: 'pmem_join000000',
    templateAgentName: 'codex',
    displayName: 'Codex',
    configuredDisplayName: 'Codex',
    settings: { managedProjectAgent: true }
  };

  const result = await createManagedMeshAgentJoin(ctx).spawnManagedSessionMember(session, member);

  expect({ lifecycle, result, startedMessages, workingPaths }).toEqual({
    lifecycle: ['runtime-owned', 'placeholder-reserved', 'initial-turn-opened'],
    result: { started: true, nativeSessionId: 'mesh_join00000000' },
    startedMessages: ['started'],
    workingPaths: [join(monadHome, 'workplace', 'prj_join00000000', 'shared')]
  });
});
