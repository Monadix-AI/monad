import type { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';

import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { registerAgentAdapterImpl } from '#/services/mesh-agent/index.ts';
import {
  cleanupManagedProjectOrphanTokens,
  prepareManagedProjectRuntime
} from '#/services/mesh-agent/managed-project.ts';
import { createNativeAgentProjectApi } from '#/services/native-agent/project.ts';

// managed-project now reads launch mode / env / mcp config / prompt style from the adapter contract,
// which the daemon populates at boot; register the built-ins so the direct-call unit tests resolve.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

test('managed project ask relies on the canonical clarification rows without wall or system-summary duplicates', async () => {
  const sessionId = 'ses_PROJECTASK000';
  const requestId = 'clarify_TEST00000001';
  const questionMessageId = 'msg_WALL00000000';
  const answerMessageId = 'msg_ANSWER000000';
  const visibleMessages: Array<{ id: string; role: string; text: string; type: string; replyToMessageId?: string }> =
    [];
  const notifications: unknown[] = [];
  let clarifyQuestionMessageId: string | undefined;
  let questionStreamStatus: 'streaming' | 'complete' | undefined;
  let completedQuestionMessages = 0;
  const handlers = {
    _nativeAgentStore: {
      createNativeAgentAsk: () => {},
      getMessage: (_sessionId: string, messageId: string) =>
        messageId === answerMessageId
          ? { createdAt: '2026-07-21T00:00:01.000Z', text: 'Ship' }
          : { createdAt: '2026-07-21T00:00:00.000Z', text: 'Which path?' },
      getNativeAgentAsk: () => null,
      getSession: () => ({ projectId: 'prj_PROJECTASK00' }),
      listSessionMembers: () => [],
      listMeshSessionsForTranscriptTarget: () => [],
      messageSeq: () => 2,
      settleNativeAgentAsk: () => {}
    },
    _transcriptProjector: {
      insertAssistantMessage: async ({
        text,
        streamStatus
      }: {
        text: string;
        streamStatus?: 'streaming' | 'complete';
      }) => {
        questionStreamStatus = streamStatus;
        visibleMessages.push({ id: questionMessageId, role: 'assistant', text, type: 'text' });
        return { messageId: questionMessageId };
      },
      completeAssistantMessage: async () => {
        completedQuestionMessages += 1;
      }
    },
    _messageIngress: {
      deliver: async ({ role, text, type }: { role: string; text: string; type: string }) => {
        visibleMessages.push({ id: 'msg_SUMMARY00000', role, text, type });
        return { id: 'msg_SUMMARY00000' };
      }
    },
    clarify: {
      askStructured: async (_sessionId: string, request: { questionMessage?: { id: string } }) => {
        clarifyQuestionMessageId = request.questionMessage?.id;
        visibleMessages.push({
          id: answerMessageId,
          role: 'user',
          text: 'Ship',
          type: 'text',
          replyToMessageId: questionMessageId
        });
        return { requestId, answer: 'Ship', status: 'answered', answerMessageId };
      }
    },
    session: {
      notifyManagedMeshAgentProjectMembers: async (notification: unknown) => {
        notifications.push(notification);
        return { accepted: true };
      }
    }
  } as unknown as ReturnType<typeof createDaemonHandlers>;
  const project = createNativeAgentProjectApi(handlers, async () => {
    throw new Error('ask does not resolve attachments');
  });

  expect(
    await project.ask({
      body: {
        blocking: false,
        requestId,
        questions: [
          {
            id: 'path',
            question: 'Which path?',
            options: ['Ship', 'Revise'],
            mode: 'single',
            allowOther: true
          }
        ]
      },
      binding: { projectMemberId: 'codex', sessionId, meshSessionId: 'mesh_codex0000000' }
    })
  ).toEqual({
    ok: true,
    requestId,
    status: 'answered',
    answer: 'Ship',
    answers: { path: 'Ship' }
  });
  expect(clarifyQuestionMessageId).toBe(questionMessageId);
  expect(questionStreamStatus).toBe('complete');
  expect(completedQuestionMessages).toBe(0);
  expect(visibleMessages).toEqual([
    { id: questionMessageId, role: 'assistant', text: 'Q: Which path?\nOptions: Ship | Revise', type: 'text' },
    { id: answerMessageId, role: 'user', text: 'Ship', type: 'text', replyToMessageId: questionMessageId }
  ]);
  expect(notifications).toEqual([
    {
      sessionId,
      text: 'Ship',
      sender: { kind: 'human', name: 'Human' },
      triggerMessageId: answerMessageId,
      exceptProjectMemberId: 'codex'
    }
  ]);
});

test('managed project runtime uses the current CLI entry without writing a wrapper bin', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_windows00000',
    provider: 'codex',
    platform: 'win32'
  });

  expect(prepared.monadCliEntry.command).toBe('bun');
  expect(prepared.monadCliEntry.args).toHaveLength(1);
  expect(prepared.monadCliEntry.args[0]?.replaceAll('\\', '/')).toEndWith('/apps/cli/src/main.ts');
});

test('managed project runtime keeps base PATH when no wrapper bin is needed', () => {
  const monadHomeWin = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}-win`);
  const preparedWin = prepareManagedProjectRuntime({
    monadHome: monadHomeWin,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_windowspath0',
    provider: 'codex',
    platform: 'win32',
    baseEnvPath: 'C:\\Windows\\system32'
  });
  expect(preparedWin.env.PATH).toBe('C:\\Windows\\system32');

  const monadHomePosix = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}-posix`);
  const preparedPosix = prepareManagedProjectRuntime({
    monadHome: monadHomePosix,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_posixpath000',
    provider: 'codex',
    platform: 'darwin',
    baseEnvPath: '/usr/bin:/bin'
  });
  expect(preparedPosix.env.PATH).toBe('/usr/bin:/bin');
});

test('managed project runtime does not blank PATH when no base PATH is supplied', () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_nopath000000',
    provider: 'codex'
  });
  expect(prepared.env).not.toHaveProperty('PATH');
});

test('managed project runtimes share the same current CLI entry per process', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const first = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_codex0000000',
    provider: 'codex'
  });
  const second = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'claude',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_claude000000',
    provider: 'claude-code'
  });

  expect(second.monadCliEntry).toEqual(first.monadCliEntry);
});

test('managed project runtime removes stale per-agent wrapper bins', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const wrapperDir = join(monadHome, 'workplace', 'prj_PROJECT00000', 'runtime', 'prj_PROJECT00000', 'codex', 'bin');
  await mkdir(wrapperDir, { recursive: true });
  await writeFile(join(wrapperDir, 'monad'), '#!/bin/sh\necho stale\n');

  prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_codex0000000',
    provider: 'codex'
  });

  await rm(monadHome, { recursive: true, force: true });
});

test('managed project runtimes expose project, agent, session, and private runtime scopes', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const codex = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    agentId: 'pm_codex',
    projectId: 'prj_PROJECT00000',
    sessionId: 'ses_FIRST0000000',
    meshSessionId: 'mesh_codex0000000',
    provider: 'codex'
  });
  const claude = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'claude',
    agentId: 'pm_claude',
    projectId: 'prj_PROJECT00000',
    sessionId: 'ses_FIRST0000000',
    meshSessionId: 'mesh_claude000000',
    provider: 'claude-code'
  });
  const codexNextSession = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    agentId: 'pm_codex',
    projectId: 'prj_PROJECT00000',
    sessionId: 'ses_SECOND000000',
    meshSessionId: 'mesh_codexsecond0',
    provider: 'codex'
  });
  const projectRoot = join(monadHome, 'workplace', 'prj_PROJECT00000');
  const sharedMemory = join(projectRoot, 'shared', 'MEMORY.md');

  expect(codex.workspaces).toEqual({
    project: projectRoot,
    shared: join(projectRoot, 'shared'),
    agent: join(projectRoot, 'agents', 'pm_codex'),
    session: join(projectRoot, 'sessions', 'ses_FIRST0000000'),
    runtime: join(projectRoot, 'runtime', 'ses_FIRST0000000', 'pm_codex')
  });
  expect(claude.workspaces.session).toBe(codex.workspaces.session);
  expect(claude.workspaces.agent).toBe(join(projectRoot, 'agents', 'pm_claude'));
  expect(codexNextSession.workspaces.agent).toBe(codex.workspaces.agent);
  expect(codexNextSession.workspaces.session).not.toBe(codex.workspaces.session);
  expect(codexNextSession.workspaces.runtime).not.toBe(codex.workspaces.runtime);
  expect(codex.env).toMatchObject({
    MONAD_PROJECT_WORKSPACE: projectRoot,
    MONAD_SHARED_WORKSPACE: codex.workspaces.shared,
    MONAD_AGENT_WORKSPACE: codex.workspaces.agent,
    MONAD_SESSION_WORKSPACE: codex.workspaces.session,
    MONAD_RUNTIME_WORKSPACE: codex.workspaces.runtime
  });
  expect(await readFile(sharedMemory, 'utf8')).toStartWith('# Project memory index');
  expect(await stat(join(projectRoot, 'shared', 'memories'))).toMatchObject({ mode: expect.any(Number) });
  expect(codex.prompt).toContain(`Session workspace: ${codex.workspaces.session}`);
  expect(codex.prompt).toContain('the agent workspace for your durable cross-session content');

  await rm(monadHome, { recursive: true, force: true });
});

test('managed project runtime uses non-interactive Codex launches', () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_codex0000000',
    provider: 'codex'
  });

  expect(prepared.env.CODEX_NON_INTERACTIVE).toBe('1');
});

test('managed project runtime uses MCP communication prompt for managed agents', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const codex = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_codex0000000',
    provider: 'codex',
    baseEnvPath: '/usr/bin:/bin'
  });
  const claude = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'claude',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_claude000000',
    provider: 'claude-code'
  });

  expect(codex.mcpConfigArgs).toContain(`mcp_servers.monad.command=${JSON.stringify(codex.monadCliEntry.command)}`);
  expect(codex.mcpConfigArgs).toContain(
    `mcp_servers.monad.args=${JSON.stringify([...codex.monadCliEntry.args, 'native-agent', 'mcp-server'])}`
  );
  expect(codex.mcpServer).toEqual({
    name: 'monad',
    command: codex.monadCliEntry.command,
    args: [...codex.monadCliEntry.args, 'native-agent', 'mcp-server'],
    env: {
      MONAD_HOME: monadHome,
      MONAD_PROJECT_WORKSPACE: codex.workspaces.project,
      MONAD_SHARED_WORKSPACE: codex.workspaces.shared,
      MONAD_AGENT_WORKSPACE: codex.workspaces.agent,
      MONAD_SESSION_WORKSPACE: codex.workspaces.session,
      MONAD_RUNTIME_WORKSPACE: codex.workspaces.runtime,
      MONAD_MESH_SESSION_ID: 'mesh_codex0000000',
      MONAD_AGENT_TOKEN_FILE: codex.tokenFile,
      MONAD_SERVER_URL: 'http://127.0.0.1:1234',
      PATH: '/usr/bin:/bin'
    }
  });
  expect(codex.mcpConfigArgs).toContain(`mcp_servers.monad.env.MONAD_HOME=${JSON.stringify(monadHome)}`);
  expect(codex.mcpConfigArgs).toContain(
    `mcp_servers.monad.env.MONAD_AGENT_TOKEN_FILE=${JSON.stringify(codex.tokenFile)}`
  );
  expect(codex.env.PATH).toBe('/usr/bin:/bin');
  expect(await Bun.file(codex.promptFile).text()).toMatch(
    /blocking: true[\s\S]*final action of the turn[\s\S]*awaiting_human[\s\S]*end the turn immediately/
  );
  expect(codex.prompt).toContain('To reply to a specific project message, use `project_post` with `replyToMessageId`.');
  expect(codex.prompt).toContain(
    'Posting without `replyToMessageId` creates an unreferenced message even while handling inbox work.'
  );
  expect(claude.mcpConfigArgs).toContain(
    JSON.stringify({
      mcpServers: {
        monad: {
          type: 'stdio',
          command: claude.monadCliEntry.command,
          args: [...claude.monadCliEntry.args, 'native-agent', 'mcp-server'],
          env: claude.env
        }
      }
    })
  );
});

test('managed project runtime writes MCP configuration for Qwen and Antigravity', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const qwen = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'qwen',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_qwen00000000',
    provider: 'qwen'
  });
  const antigravity = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'antigravity',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_antigravity0',
    provider: 'antigravity'
  });

  expect(JSON.parse(await readFile(join(qwen.workspace, '.qwen', 'settings.json'), 'utf8'))).toEqual({
    mcpServers: {
      monad: { command: qwen.mcpServer.command, args: qwen.mcpServer.args, env: qwen.mcpServer.env, trust: true }
    }
  });
  expect(JSON.parse(await readFile(join(antigravity.workspace, '.agents', 'mcp_config.json'), 'utf8'))).toEqual({
    mcpServers: {
      monad: {
        command: antigravity.mcpServer.command,
        args: antigravity.mcpServer.args,
        env: antigravity.mcpServer.env
      }
    }
  });
  for (const prepared of [qwen, antigravity]) {
    expect(prepared.prompt).toContain('Use only tools from the `monad` MCP server');
    expect(prepared.prompt).not.toContain('monad project');
  }
});

test('managed project runtime treats room wakes as broadcasts that do not require a reply', () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prompts = ['codex', 'gemini'].map(
    (provider) =>
      prepareManagedProjectRuntime({
        monadHome,
        serverUrl: 'http://127.0.0.1:1234',
        agentName: provider,
        projectId: 'prj_PROJECT00000',
        meshSessionId: `mesh_${provider}000000`,
        provider
      }).prompt
  );

  for (const prompt of prompts) {
    expect(prompt).toContain('Use only tools from the `monad` MCP server');
    expect(prompt).not.toContain('monad project');
    expect(prompt).toContain('Every project-room message is broadcast to every managed agent.');
    expect(prompt).toContain('A wake means new context is available, not that a public response is required.');
    expect(prompt).toContain('For agent/system messages, default to no public response.');
  }
});

test('managed project runtime rejects agent ids that escape the project workspace', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  expect(() =>
    prepareManagedProjectRuntime({
      monadHome,
      serverUrl: 'http://127.0.0.1:1234',
      agentName: '../../escaped-agent',
      agentId: '../../escaped-agent',
      projectId: 'prj_PROJECT00000',
      meshSessionId: 'mesh_escape000000',
      provider: 'codex'
    })
  ).toThrow('managed MeshAgent workspace must stay inside the project root');
});

test('managed project runtime rotates its agent token for each prepared MeshAgent session', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const first = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_first0000000',
    provider: 'codex'
  });
  const firstToken = await readFile(first.tokenFile, 'utf8');
  const second = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_second000000',
    provider: 'codex'
  });

  expect(await readFile(second.tokenFile, 'utf8')).not.toBe(firstToken);
  expect(second.tokenHash).not.toBe(first.tokenHash);
});

test('managed project runtime writes the prompt file it returns', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    displayName: 'Reviewer',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_prompt000000',
    provider: 'codex',
    modelId: 'gpt-5.5',
    reasoningEffort: 'high',
    speed: 'fast'
  });

  expect(await readFile(prepared.promptFile, 'utf8')).toBe(prepared.prompt);
  expect(prepared.promptFile).toBe(join(prepared.workspace, 'GEMINI.md'));
  // presence-ok: ephemeral runtime bindings and join triggers must never enter immutable instructions.
  expect(prepared.prompt).not.toContain('mesh_prompt000000');
  expect(prepared.prompt).not.toContain('When this managed project session starts');
  expect(prepared.prompt).not.toContain('When this managed project session starts, acknowledge');
});

test('managed project runtime recreates token files with owner-only permissions', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace', 'prj_PROJECT00000', 'runtime', 'prj_PROJECT00000', 'codex');
  await mkdir(workspace, { recursive: true });
  const tokenFile = join(workspace, '.monad-agent-token');
  await writeFile(tokenFile, 'stale-token');
  await chmod(tokenFile, 0o644);

  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    meshSessionId: 'mesh_first0000000',
    provider: 'codex'
  });

  expect(prepared.tokenFile).toBe(tokenFile);
  expect(await readFile(tokenFile, 'utf8')).not.toBe('stale-token');
  if (process.platform !== 'win32') expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
});

test('managed project orphan token cleanup removes stale runtime tokens without deleting memory', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace', 'prj_PROJECT00000', 'codex');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, '.monad-agent-token'), 'stale-token');
  await writeFile(join(workspace, 'MEMORY.md'), '# durable memory\n');

  expect(cleanupManagedProjectOrphanTokens(monadHome)).toBe(1);
  expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toBe('# durable memory\n');
});

test('managed project orphan token cleanup does not follow workspace symlink directories', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const external = join(tmpdir(), `monad-managed-runtime-external-${Date.now()}-${process.hrtime.bigint()}`);
  await mkdir(join(monadHome, 'workplace'), { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(join(external, '.monad-agent-token'), 'external-token');
  await symlink(external, join(monadHome, 'workplace', 'linked-external'), 'dir');

  expect(cleanupManagedProjectOrphanTokens(monadHome)).toBe(0);
  expect(await readFile(join(external, '.monad-agent-token'), 'utf8')).toBe('external-token');
});
