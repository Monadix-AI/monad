import { expect, test } from 'bun:test';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { builtinAgentAdapters } from '@monad/atoms/agent-adapters';

import { registerAgentAdapterImpl } from '@/services/native-cli/index.ts';
import {
  buildManagedProjectCliWrapperScript,
  cleanupManagedProjectOrphanTokens,
  managedProjectCliWrapperName,
  managedProjectLaunchMode,
  prepareManagedProjectRuntime
} from '@/services/native-cli/managed-project.ts';

// managed-project now reads launch mode / env / mcp config / prompt style from the adapter contract,
// which the daemon populates at boot; register the built-ins so the direct-call unit tests resolve.
for (const adapter of builtinAgentAdapters) registerAgentAdapterImpl(adapter);

test('managed project CLI wrapper uses source entry in development', () => {
  expect(buildManagedProjectCliWrapperScript('/repo/apps/cli/src/main.ts', '/Applications/Monad.app/monad')).toBe(
    '#!/usr/bin/env sh\nexec bun "/repo/apps/cli/src/main.ts" "$@"\n'
  );
});

test('managed project CLI wrapper falls back to the current executable in packaged builds', () => {
  expect(buildManagedProjectCliWrapperScript(null, '/Applications/Monad.app/Contents/MacOS/Monad')).toBe(
    '#!/usr/bin/env sh\nexec "/Applications/Monad.app/Contents/MacOS/Monad" "$@"\n'
  );
});

test('managed project CLI wrapper creates a Windows cmd shim in development', () => {
  expect(
    buildManagedProjectCliWrapperScript(
      'C:\\repo\\apps\\cli\\src\\main.ts',
      'C:\\Program Files\\Monad\\Monad.exe',
      'win32'
    )
  ).toBe('@echo off\r\nbun "C:\\repo\\apps\\cli\\src\\main.ts" %*\r\n');
});

test('managed project CLI wrapper creates a Windows cmd shim in packaged builds', () => {
  expect(buildManagedProjectCliWrapperScript(null, 'C:\\Program Files\\Monad\\Monad.exe', 'win32')).toBe(
    '@echo off\r\n"C:\\Program Files\\Monad\\Monad.exe" %*\r\n'
  );
});

test('managed project runtime uses the platform wrapper filename', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_windows',
    provider: 'codex',
    platform: 'win32'
  });

  expect(prepared.wrapperBin.endsWith(`${managedProjectCliWrapperName('win32')}`)).toBe(true);
  expect(await readFile(prepared.wrapperBin, 'utf8')).toStartWith('@echo off\r\n');
});

test('managed project runtime joins the wrapper bin dir onto baseEnvPath with the platform PATH separator', () => {
  const monadHomeWin = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}-win`);
  const preparedWin = prepareManagedProjectRuntime({
    monadHome: monadHomeWin,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_windows_path',
    provider: 'codex',
    platform: 'win32',
    baseEnvPath: 'C:\\Windows\\system32'
  });
  expect(preparedWin.env.PATH).toBe(
    `${join(monadHomeWin, 'workplace-agents', 'prj_PROJECT', 'codex', 'bin')};C:\\Windows\\system32`
  );

  const monadHomePosix = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}-posix`);
  const preparedPosix = prepareManagedProjectRuntime({
    monadHome: monadHomePosix,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_posix_path',
    provider: 'codex',
    platform: 'darwin',
    baseEnvPath: '/usr/bin:/bin'
  });
  expect(preparedPosix.env.PATH).toBe(
    `${join(monadHomePosix, 'workplace-agents', 'prj_PROJECT', 'codex', 'bin')}:/usr/bin:/bin`
  );
});

test('managed project runtime uses non-interactive Codex launches', () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_codex',
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
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_codex',
    provider: 'codex'
  });
  const claude = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'claude',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_claude',
    provider: 'claude-code'
  });

  expect(codex.prompt).toContain('MCP server named `monad`');
  expect(codex.prompt).toContain('Every side-effect MCP call must include a stable `requestId`');
  expect(codex.prompt).toContain('`project_post`');
  expect(codex.prompt).toContain('`project_post` tool from the `monad` MCP server');
  expect(codex.prompt).not.toContain('`monad project post -`');
  expect(codex.mcpConfigArgs).toContain('-c');
  expect(codex.mcpConfigArgs).toContain(`mcp_servers.monad.command=${JSON.stringify(codex.wrapperBin)}`);
  expect(codex.mcpConfigArgs).toContain('mcp_servers.monad.args=["native-agent","mcp-server"]');
  expect(codex.mcpConfigArgs).toContain(`mcp_servers.monad.env.MONAD_HOME=${JSON.stringify(monadHome)}`);
  expect(codex.mcpConfigArgs).toContain('mcp_servers.monad.env.MONAD_SERVER_URL="http://127.0.0.1:1234"');
  expect(codex.mcpConfigArgs).toContain('mcp_servers.monad.env.MONAD_NATIVE_CLI_SESSION_ID="ncli_codex"');
  expect(codex.mcpConfigArgs).toContain(
    `mcp_servers.monad.env.MONAD_AGENT_TOKEN_FILE=${JSON.stringify(codex.tokenFile)}`
  );
  expect(codex.mcpConfigArgs).toContain(`mcp_servers.monad.env.PATH=${JSON.stringify(codex.env.PATH)}`);
  expect(codex.mcpConfigArgs).toContain('mcp_servers.monad.tools.project_inbox_check.approval_mode="approve"');
  expect(codex.mcpConfigArgs).toContain('mcp_servers.monad.tools.project_post.approval_mode="approve"');
  expect(claude.prompt).toContain('MCP server named `monad`');
  expect(claude.prompt).toContain('`project_post` tool from the `monad` MCP server');
  expect(claude.prompt).not.toContain('`monad project post -`');
  expect(claude.mcpConfigArgs).toContain('--mcp-config');
  expect(claude.mcpConfigArgs).toContain(
    JSON.stringify({
      mcpServers: {
        monad: {
          type: 'stdio',
          command: claude.wrapperBin,
          args: ['native-agent', 'mcp-server'],
          env: claude.env
        }
      }
    })
  );
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
  const escapedWorkspace = join(monadHome, 'escaped-agent');

  expect(() =>
    prepareManagedProjectRuntime({
      monadHome,
      serverUrl: 'http://127.0.0.1:1234',
      agentName: '../../escaped-agent',
      projectId: 'prj_PROJECT',
      nativeCliSessionId: 'ncli_escape',
      provider: 'codex'
    })
  ).toThrow('managed native CLI workspace must stay inside the project agent root');
  expect(await readFile(join(escapedWorkspace, '.monad-agent-token'), 'utf8').catch(() => null)).toBeNull();
  expect(await readFile(join(escapedWorkspace, 'managed-prompt.md'), 'utf8').catch(() => null)).toBeNull();
});

test('managed project runtime rotates its agent token for each prepared native CLI session', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const first = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_first',
    provider: 'codex'
  });
  const firstToken = await readFile(first.tokenFile, 'utf8');
  const second = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_second',
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
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_prompt',
    provider: 'codex',
    modelId: 'gpt-5.5',
    reasoningEffort: 'high',
    speed: 'fast'
  });

  expect(await readFile(prepared.promptFile, 'utf8')).toBe(prepared.prompt);
});

test('managed project runtime recreates token files with owner-only permissions', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace-agents', 'prj_PROJECT', 'codex');
  await mkdir(workspace, { recursive: true });
  const tokenFile = join(workspace, '.monad-agent-token');
  await writeFile(tokenFile, 'stale-token');
  await chmod(tokenFile, 0o644);

  const prepared = prepareManagedProjectRuntime({
    monadHome,
    serverUrl: 'http://127.0.0.1:1234',
    agentName: 'codex',
    projectId: 'prj_PROJECT',
    nativeCliSessionId: 'ncli_first',
    provider: 'codex'
  });

  expect(prepared.tokenFile).toBe(tokenFile);
  expect(await readFile(tokenFile, 'utf8')).not.toBe('stale-token');
  expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
});

test('managed project orphan token cleanup removes stale runtime tokens without deleting memory', async () => {
  const monadHome = join(tmpdir(), `monad-managed-runtime-${Date.now()}-${process.hrtime.bigint()}`);
  const workspace = join(monadHome, 'workplace-agents', 'prj_PROJECT', 'codex');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, '.monad-agent-token'), 'stale-token');
  await writeFile(join(workspace, 'MEMORY.md'), '# durable memory\n');

  expect(cleanupManagedProjectOrphanTokens(monadHome)).toBe(1);
  expect(await readFile(join(workspace, '.monad-agent-token'), 'utf8').catch(() => null)).toBeNull();
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
