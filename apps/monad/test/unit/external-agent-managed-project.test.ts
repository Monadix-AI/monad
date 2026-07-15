import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { registerAgentAdapterImpl } from '#/services/external-agent/index.ts';
import {
  cleanupManagedProjectOrphanTokens,
  managedProjectLaunchMode,
  prepareManagedProjectRuntime
} from '#/services/external-agent/managed-project.ts';

// managed-project now reads launch mode / env / mcp config / prompt style from the adapter contract,
// which the daemon populates at boot; register the built-ins so the direct-call unit tests resolve.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

test('managed project runtime uses the current CLI entry without writing a wrapper bin', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_windows00000',
    provider: 'codex',
    platform: 'win32'
  });

  expect(prepared.monadCliEntry.command).toBe('bun');
  expect(prepared.monadCliEntry.args).toHaveLength(1);
  expect(prepared.monadCliEntry.args[0]).toEndWith('/apps/cli/src/main.ts');
});

test('managed project runtime keeps base PATH when no wrapper bin is needed', () => {
  const monadHomeWin = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}-win`);
  const preparedWin = prepareManagedProjectRuntime({
    monadHome: monadHomeWin,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_windowspath0',
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
    externalAgentSessionId: 'exa_posixpath000',
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
    externalAgentSessionId: 'exa_nopath000000',
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
    externalAgentSessionId: 'exa_codex0000000',
    provider: 'codex'
  });
  const second = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'claude',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_claude000000',
    provider: 'claude-code'
  });

  expect(second.monadCliEntry).toEqual(first.monadCliEntry);
});

test('managed project runtime removes stale per-agent wrapper bins', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const wrapperDir = join(monadHome, 'workplace-agents', 'prj_PROJECT00000', 'codex', 'bin');
  await mkdir(wrapperDir, { recursive: true });
  await writeFile(join(wrapperDir, 'monad'), '#!/bin/sh\necho stale\n');

  prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_codex0000000',
    provider: 'codex'
  });

  await rm(monadHome, { recursive: true, force: true });
});

test('managed project runtimes share a project root memory index', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const codex = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_codex0000000',
    provider: 'codex'
  });
  const claude = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'claude',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_claude000000',
    provider: 'claude-code'
  });
  const projectRoot = join(monadHome, 'workplace-agents', 'prj_PROJECT00000');
  const sharedMemory = join(projectRoot, 'MEMORY.md');

  expect(codex.workspace).toBe(join(projectRoot, 'codex'));
  expect(claude.workspace).toBe(join(projectRoot, 'claude'));
  expect(await readFile(sharedMemory, 'utf8')).toStartWith('# Project memory index');
  expect(await stat(join(projectRoot, 'memories'))).toMatchObject({ mode: expect.any(Number) });

  await rm(monadHome, { recursive: true, force: true });
});

test('managed project runtime uses non-interactive Codex launches', () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_codex0000000',
    provider: 'codex'
  });

  expect(prepared.env.CODEX_NON_INTERACTIVE).toBe('1');
});

test('managed project runtime uses MCP communication prompt for managed MCP bridge providers', () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const codex = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_codex0000000',
    provider: 'codex',
    baseEnvPath: '/usr/bin:/bin'
  });
  const claude = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'claude',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_claude000000',
    provider: 'claude-code'
  });

  expect(codex.mcpConfigArgs).toContain(`mcp_servers.monad.command=${JSON.stringify(codex.monadCliEntry.command)}`);
  expect(codex.mcpConfigArgs).toContain(
    `mcp_servers.monad.args=${JSON.stringify([...codex.monadCliEntry.args, 'native-agent', 'mcp-server'])}`
  );
  expect(codex.mcpConfigArgs).toContain(`mcp_servers.monad.env.MONAD_HOME=${JSON.stringify(monadHome)}`);
  expect(codex.mcpConfigArgs).toContain(
    `mcp_servers.monad.env.MONAD_AGENT_TOKEN_FILE=${JSON.stringify(codex.tokenFile)}`
  );
  expect(codex.env.PATH).toBe('/usr/bin:/bin');
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

test('managed project runtime renders the current CLI entry in non-MCP communication prompts', () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'gemini',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_gemini000000',
    provider: 'gemini'
  });
  const command = [prepared.monadCliEntry.command, ...prepared.monadCliEntry.args].join(' ');

  expect(prepared.prompt).toContain(`${command} project post -`);
  expect(prepared.prompt).toContain(`${command} project inbox check`);
});

test('managed project runtime prefers structured launch modes over interactive PTY', () => {
  expect(managedProjectLaunchMode({ provider: 'codex', defaultLaunchMode: 'pty' }, 'pty')).toBe('app-server');
  expect(managedProjectLaunchMode({ provider: 'claude-code', defaultLaunchMode: 'pty' }, 'pty')).toBe('json-stream');
  expect(managedProjectLaunchMode({ provider: 'gemini', defaultLaunchMode: 'pty' }, 'pty')).toBe('json-stream');
  expect(managedProjectLaunchMode({ provider: 'qwen', defaultLaunchMode: 'pty' }, 'pty')).toBe('json-stream');
  expect(managedProjectLaunchMode({ provider: 'codex', defaultLaunchMode: 'pty' }, 'app-server')).toBe('app-server');
});

test('managed project runtime rejects agent names that escape the project workspace', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  expect(() =>
    prepareManagedProjectRuntime({
      monadHome,
      serverUrl: 'http://127.0.0.1:1234',
      agentName: '../../escaped-agent',
      projectId: 'prj_PROJECT00000',
      externalAgentSessionId: 'exa_escape000000',
      provider: 'codex'
    })
  ).toThrow('managed external agent workspace must stay inside the project agent root');
});

test('managed project runtime rotates its agent token for each prepared external agent session', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const first = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_first0000000',
    provider: 'codex'
  });
  const firstToken = await readFile(first.tokenFile, 'utf8');
  const second = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_second000000',
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
    externalAgentSessionId: 'exa_prompt000000',
    provider: 'codex',
    modelId: 'gpt-5.5',
    reasoningEffort: 'high',
    speed: 'fast'
  });

  expect(await readFile(prepared.promptFile, 'utf8')).toBe(prepared.prompt);
});

test('managed project runtime recreates token files with owner-only permissions', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace-agents', 'prj_PROJECT00000', 'codex');
  await mkdir(workspace, { recursive: true });
  const tokenFile = join(workspace, '.monad-agent-token');
  await writeFile(tokenFile, 'stale-token');
  await chmod(tokenFile, 0o644);

  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT00000',
    externalAgentSessionId: 'exa_first0000000',
    provider: 'codex'
  });

  expect(prepared.tokenFile).toBe(tokenFile);
  expect(await readFile(tokenFile, 'utf8')).not.toBe('stale-token');
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
});

test('managed project orphan token cleanup removes stale runtime tokens without deleting memory', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace-agents', 'prj_PROJECT00000', 'codex');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, '.monad-agent-token'), 'stale-token');
  await writeFile(join(workspace, 'MEMORY.md'), '# durable memory\n');

  expect(cleanupManagedProjectOrphanTokens(monadHome)).toBe(1);
  expect(await readFile(join(workspace, 'MEMORY.md'), 'utf8')).toBe('# durable memory\n');
});

test('managed project orphan token cleanup does not follow workspace symlink directories', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const external = join(tmpdir(), `monad-managed-runtime-external-${Date.now()}-${process.hrtime.bigint()}`);
  await mkdir(join(monadHome, 'workplace-agents'), { recursive: true });
  await mkdir(external, { recursive: true });
  await writeFile(join(external, '.monad-agent-token'), 'external-token');
  await symlink(external, join(monadHome, 'workplace-agents', 'linked-external'), 'dir');

  expect(cleanupManagedProjectOrphanTokens(monadHome)).toBe(0);
  expect(await readFile(join(external, '.monad-agent-token'), 'utf8')).toBe('external-token');
});
