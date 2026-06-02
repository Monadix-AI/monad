import type { ProtectedCredential, ProtectedExecutionProxy, SandboxLauncher } from '@monad/sandbox';
import type { ToolContext } from '#/capabilities/tools/types.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/environment';

import {
  clearProcesses,
  codeExecTool,
  configureCodeExec,
  configureProtectedCredentialResolver,
  configureProtectedExecutionProxyStarter,
  configureProtectedExecutionTls,
  configureSandboxLauncher,
  noneLauncher,
  processControlTool,
  resolveProtectedExecutionForAgent,
  sandboxedSpawn,
  shellExecTool
} from '#/capabilities/tools';
import { buildHandlers, mockModel, stubConfigAccess } from '../../helpers.ts';

const secret = 'task-6-real-secret-canary';
const sentinel = 'fake_value_00000000-0000-4000-8000-000000000006';
const credential: ProtectedCredential = {
  environmentVariable: 'AGENT_TOKEN',
  secret,
  allowedHosts: ['api.example.com']
};
const AGENT_A = 'agt_0000000000A1' as const;
const AGENT_B = 'agt_0000000000B2' as const;

function resolution(
  credentials: readonly ProtectedCredential[],
  credentialVaultContainsSecrets = credentials.length > 0
) {
  return { credentials, credentialVaultContainsSecrets };
}

function protectedLauncher(onWrap?: (policy: Parameters<NonNullable<SandboxLauncher['wrap']>>[1]) => void) {
  return {
    kind: 'protected-local',
    descriptor: { name: 'Protected local' },
    enforces: { readDeny: true, net: ['filtered'] },
    wrap(argv, policy) {
      onWrap?.(policy);
      return argv;
    }
  } satisfies SandboxLauncher;
}

afterEach(() => {
  configureProtectedCredentialResolver(undefined);
  configureProtectedExecutionProxyStarter(undefined);
  configureProtectedExecutionTls(false);
  configureSandboxLauncher(noneLauncher);
  configureCodeExec('follow-system');
  clearProcesses();
});

test('Code Act, shell_exec, and background process all enter the protected spawn path', async () => {
  const proxyStarts: string[][] = [];
  let closeCalls = 0;
  configureProtectedCredentialResolver(async () => resolution([credential]));
  configureProtectedExecutionTls(true);
  configureProtectedExecutionProxyStarter((credentials) => {
    proxyStarts.push(credentials.map((item) => item.environmentVariable));
    return {
      childEnv: Object.freeze({ AGENT_TOKEN: sentinel }),
      proxyEnv: Object.freeze({ HTTPS_PROXY: 'http://127.0.0.1:43123' }),
      port: 43123,
      close: async () => {
        closeCalls += 1;
      }
    };
  });
  configureSandboxLauncher(protectedLauncher());
  const ctx: ToolContext = {
    sessionId: 'session-protected',
    agentId: 'agent-1',
    sandboxRoots: undefined,
    log: () => {}
  };

  const code = await codeExecTool.run({ language: 'javascript', code: 'console.log(process.env.AGENT_TOKEN)' }, ctx);
  expect(code.metadata.stdout.trim()).toBe(sentinel);

  const shell = await shellExecTool.run({ command: 'printf "%s" "$AGENT_TOKEN"' }, ctx);
  expect(shell.metadata.stdout).toBe(sentinel);

  const background = await shellExecTool.run(
    { command: 'sleep 0.1; printf "%s" "$AGENT_TOKEN"', mode: 'background', terminalMode: 'pipe' },
    ctx
  );
  expect(background.metadata.status).toBe('running');
  expect(closeCalls).toBe(2);
  const waited = await processControlTool.run(
    { action: 'wait', id: background.metadata.processId, pattern: sentinel, timeoutMs: 2_000 },
    ctx
  );
  expect('matched' in waited.metadata && waited.metadata.matched).toBe(true);
  await processControlTool.run({ action: 'wait', id: background.metadata.processId, timeoutMs: 2_000 }, ctx);

  expect(proxyStarts).toEqual([['AGENT_TOKEN'], ['AGENT_TOKEN'], ['AGENT_TOKEN']]);
  expect(closeCalls).toBe(3);
  expect(JSON.stringify([code.metadata, shell.metadata, background.metadata, waited.metadata])).not.toContain(secret);
});

test('the three execution surfaces do not start a proxy for an agent without grants', async () => {
  let proxyStarts = 0;
  configureProtectedCredentialResolver(async () => resolution([]));
  configureProtectedExecutionProxyStarter(() => {
    proxyStarts += 1;
    throw new Error('must not start');
  });
  configureSandboxLauncher(noneLauncher);
  const ctx: ToolContext = {
    sessionId: 'session-ordinary',
    agentId: 'agent-no-grants',
    sandboxRoots: undefined,
    log: () => {}
  };

  const code = await codeExecTool.run({ language: 'javascript', code: 'console.log("code")' }, ctx);
  const shell = await shellExecTool.run({ command: 'printf shell' }, ctx);
  const background = await shellExecTool.run(
    { command: 'printf background', mode: 'background', terminalMode: 'pipe' },
    ctx
  );
  const waited = await processControlTool.run(
    { action: 'wait', id: background.metadata.processId, pattern: 'background', timeoutMs: 2_000 },
    ctx
  );

  expect({
    code: code.metadata.stdout.trim(),
    shell: shell.metadata.stdout,
    backgroundMatched: 'matched' in waited.metadata && waited.metadata.matched,
    proxyStarts
  }).toEqual({ code: 'code', shell: 'shell', backgroundMatched: true, proxyStarts: 0 });
});

test('a credentialed spawn gives the child only a sentinel and owns the proxy until exit', async () => {
  const events: string[] = [];
  let resolved: readonly ProtectedCredential[] | undefined;
  let seenPolicy: Parameters<NonNullable<SandboxLauncher['wrap']>>[1] | undefined;
  let closeCalls = 0;
  configureProtectedCredentialResolver(async (agentId) => {
    expect(agentId).toBe('agent-1');
    return resolution([credential]);
  });
  configureProtectedExecutionTls(true);
  configureProtectedExecutionProxyStarter((credentials) => {
    events.push('proxy');
    resolved = credentials;
    return {
      childEnv: Object.freeze({ AGENT_TOKEN: sentinel }),
      proxyEnv: Object.freeze({
        HTTPS_PROXY: 'http://127.0.0.1:43123',
        NODE_EXTRA_CA_CERTS: '/ephemeral/ca.pem'
      }),
      port: 43123,
      close: async () => {
        closeCalls += 1;
        events.push('closed');
      }
    } satisfies ProtectedExecutionProxy;
  });
  configureSandboxLauncher(
    protectedLauncher((policy) => {
      events.push('spawn');
      seenPolicy = policy;
    })
  );

  const protectedExecution = await resolveProtectedExecutionForAgent('agent-1');
  const proc = sandboxedSpawn(
    [
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify({ token: process.env.AGENT_TOKEN, proxy: process.env.HTTPS_PROXY }))'
    ],
    { stdout: 'pipe', stderr: 'pipe' },
    {},
    { agentId: 'agent-1', protectedExecution }
  );
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  await Bun.sleep(0);

  expect(output).toBe(JSON.stringify({ token: sentinel, proxy: 'http://127.0.0.1:43123' }));
  expect(output).not.toContain(secret);
  expect(resolved).toEqual([credential]);
  expect(Object.isFrozen(resolved)).toBe(true);
  expect(Object.isFrozen(resolved?.[0])).toBe(true);
  expect(seenPolicy?.net).toEqual({ allowProxyPort: 43123 });
  expect(events).toEqual(['proxy', 'spawn', 'closed']);
  expect(closeCalls).toBe(1);
});

describe('protected execution fails before launch', () => {
  const cases: Array<{
    name: string;
    configure(): void;
  }> = [
    {
      name: 'no resolver',
      configure() {
        configureProtectedExecutionTls(true);
      }
    },
    {
      name: 'missing secret',
      configure() {
        configureProtectedCredentialResolver(async () => resolution([{ ...credential, secret: '' }]));
        configureProtectedExecutionTls(true);
      }
    },
    {
      name: 'TLS disabled',
      configure() {
        configureProtectedCredentialResolver(async () => resolution([credential]));
      }
    },
    {
      name: 'no launcher',
      configure() {
        configureProtectedCredentialResolver(async () => resolution([credential]));
        configureProtectedExecutionTls(true);
        configureSandboxLauncher(noneLauncher);
      }
    },
    {
      name: 'unsupported launcher',
      configure() {
        configureProtectedCredentialResolver(async () => resolution([credential]));
        configureProtectedExecutionTls(true);
        configureSandboxLauncher({
          kind: 'remote',
          descriptor: { name: 'Remote' },
          enforces: { net: ['filtered'] },
          spawn: () => {
            throw new Error('child launch must not run');
          }
        });
      }
    },
    {
      name: 'non-enforceable network',
      configure() {
        configureProtectedCredentialResolver(async () => resolution([credential]));
        configureProtectedExecutionTls(true);
        configureSandboxLauncher({
          kind: 'local-but-bypassable',
          descriptor: { name: 'Local' },
          enforces: { net: ['none'] },
          wrap: (argv) => argv
        });
      }
    },
    {
      name: 'proxy startup failure',
      configure() {
        configureProtectedCredentialResolver(async () => resolution([credential]));
        configureProtectedExecutionTls(true);
        configureProtectedExecutionProxyStarter(() => {
          throw new Error(`native proxy detail ${secret}`);
        });
      }
    }
  ];

  for (const item of cases) {
    test(item.name, async () => {
      let launches = 0;
      configureSandboxLauncher(
        protectedLauncher(() => {
          launches += 1;
        })
      );
      item.configure();

      const launch = async () => {
        const protectedExecution = await resolveProtectedExecutionForAgent('agent-1');
        return sandboxedSpawn(
          [process.execPath, '-e', 'process.exit(0)'],
          { stdout: 'pipe' },
          {},
          { agentId: 'agent-1', protectedExecution }
        );
      };
      await expect(launch()).rejects.toThrow('protected_execution_unavailable');
      expect(launches).toBe(0);
    });
  }
});

test('credentialed host and container Code Act targets fail before any launcher spawn', async () => {
  let launches = 0;
  configureProtectedCredentialResolver(async () => resolution([credential]));
  configureProtectedExecutionTls(true);
  configureSandboxLauncher(
    protectedLauncher(() => {
      launches += 1;
    })
  );
  const ctx: ToolContext = {
    sessionId: 'session-unsupported-target',
    agentId: 'agent-1',
    sandboxRoots: undefined,
    log: () => {}
  };

  await expect(
    codeExecTool.run({ language: 'javascript', code: 'console.log("x")', target: 'host' }, ctx)
  ).rejects.toThrow('protected_execution_unavailable');
  configureCodeExec('docker');
  await expect(codeExecTool.run({ language: 'javascript', code: 'console.log("x")' }, ctx)).rejects.toThrow(
    'protected_execution_unavailable'
  );
  expect(launches).toBe(0);
});

test('a credentialed delegated terminal fails before invoking the remote backend', async () => {
  let delegatedCalls = 0;
  configureProtectedCredentialResolver(async () => resolution([credential]));
  const ctx: ToolContext = {
    sessionId: 'session-delegated',
    agentId: 'agent-1',
    sandboxRoots: undefined,
    log: () => {},
    backends: {
      fs: {
        delegated: true,
        readTextFile: async () => '',
        writeTextFile: async (path, content) => ({ path, bytesWritten: content.length })
      },
      terminal: {
        delegated: true,
        exec: async () => {
          delegatedCalls += 1;
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
      }
    }
  };

  await expect(shellExecTool.run({ command: 'echo x' }, ctx)).rejects.toThrow('protected_execution_unavailable');
  expect(delegatedCalls).toBe(0);
});

test.each([
  { name: 'foreground normal cwd', input: { command: 'echo x' } },
  { name: 'foreground approved cwd escape', input: { command: 'echo x', cwd: '/outside-approved' } },
  {
    name: 'background pipe',
    input: { command: 'echo x', mode: 'background' as const, terminalMode: 'pipe' as const }
  },
  {
    name: 'background pty',
    input: { command: 'echo x', mode: 'background' as const, terminalMode: 'pty' as const }
  }
])('credentialed delegated $name fails before approval, proxy, local, or delegated launch', async ({ input }) => {
  let approvals = 0;
  let delegatedCalls = 0;
  let localLaunches = 0;
  let proxyStarts = 0;
  configureProtectedCredentialResolver(async () => resolution([credential]));
  configureProtectedExecutionTls(true);
  configureProtectedExecutionProxyStarter(() => {
    proxyStarts += 1;
    throw new Error('must not start');
  });
  configureSandboxLauncher(
    protectedLauncher(() => {
      localLaunches += 1;
    })
  );
  const ctx: ToolContext = {
    sessionId: 'session-delegated-matrix',
    agentId: 'agent-1',
    sandboxRoots: ['/sandbox-root'],
    log: () => {},
    gate: async () => {
      approvals += 1;
      return { allow: true };
    },
    backends: {
      fs: {
        delegated: true,
        readTextFile: async () => '',
        writeTextFile: async (path, content) => ({ path, bytesWritten: content.length })
      },
      terminal: {
        delegated: true,
        exec: async () => {
          delegatedCalls += 1;
          return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
        }
      }
    }
  };

  await expect(shellExecTool.run(input, ctx)).rejects.toThrow('protected_execution_unavailable');
  expect({ approvals, delegatedCalls, localLaunches, proxyStarts }).toEqual({
    approvals: 0,
    delegatedCalls: 0,
    localLaunches: 0,
    proxyStarts: 0
  });
});

test('an agent with no grants preserves the ordinary spawn path', async () => {
  let proxyStarts = 0;
  configureProtectedCredentialResolver(async () => resolution([]));
  configureProtectedExecutionProxyStarter(() => {
    proxyStarts += 1;
    throw new Error('must not start');
  });
  configureSandboxLauncher(noneLauncher);

  const protectedExecution = await resolveProtectedExecutionForAgent('agent-without-grants');
  const proc = sandboxedSpawn(
    [process.execPath, '-e', 'process.stdout.write("ordinary")'],
    { stdout: 'pipe' },
    {},
    { agentId: 'agent-without-grants', protectedExecution }
  );
  expect(await new Response(proc.stdout).text()).toBe('ordinary');
  expect(await proc.exited).toBe(0);
  expect(proxyStarts).toBe(0);
});

test('a nonempty vault requires enforced read denial even when the agent has zero grants', async () => {
  let launches = 0;
  configureProtectedCredentialResolver(async () => resolution([], true));
  configureSandboxLauncher({
    kind: 'vault-blind-local',
    descriptor: { name: 'Vault blind local' },
    enforces: { net: ['filtered'] },
    wrap: (argv) => {
      launches += 1;
      return argv;
    }
  });
  const ctx: ToolContext = {
    sessionId: 'session-vault-guard',
    agentId: 'agent-no-grants',
    sandboxRoots: undefined,
    log: () => {}
  };

  await expect(shellExecTool.run({ command: 'printf unsafe' }, ctx)).rejects.toThrow('protected_execution_unavailable');
  await expect(codeExecTool.run({ language: 'javascript', code: 'console.log("unsafe")' }, ctx)).rejects.toThrow(
    'protected_execution_unavailable'
  );
  expect(launches).toBe(0);

  configureSandboxLauncher({
    kind: 'vault-safe-local',
    descriptor: { name: 'Vault safe local' },
    enforces: { readDeny: true, net: ['filtered'] },
    wrap: (argv) => {
      launches += 1;
      return argv;
    }
  });
  const shell = await shellExecTool.run({ command: 'printf safe' }, ctx);
  const code = await codeExecTool.run({ language: 'javascript', code: 'console.log("safe")' }, ctx);

  expect({ shell: shell.metadata.stdout, code: code.metadata.stdout.trim(), launches }).toEqual({
    shell: 'safe',
    code: 'safe',
    launches: 2
  });
});

test('a missing agent identity still enforces a nonempty vault read denial', async () => {
  let launches = 0;
  configureProtectedCredentialResolver(async (agentId) => {
    expect(agentId).toBeUndefined();
    return resolution([], true);
  });
  configureSandboxLauncher({
    kind: 'vault-blind-unbound',
    descriptor: { name: 'Vault blind unbound' },
    enforces: { net: ['filtered'] },
    wrap: (argv) => {
      launches += 1;
      return argv;
    }
  });
  const ctx: ToolContext = {
    sessionId: 'session-vault-unbound',
    sandboxRoots: undefined,
    log: () => {}
  };

  await expect(shellExecTool.run({ command: 'printf unsafe' }, ctx)).rejects.toThrow('protected_execution_unavailable');
  await expect(codeExecTool.run({ language: 'javascript', code: 'console.log("unsafe")' }, ctx)).rejects.toThrow(
    'protected_execution_unavailable'
  );
  expect(launches).toBe(0);
});

test.skipIf(process.platform === 'win32').each(['pipe', 'pty'] as const)(
  'session rebind terminates agent A protected %s process before agent B can observe or control it',
  async (terminalMode) => {
    let closeCalls = 0;
    configureProtectedCredentialResolver(async () => resolution([credential]));
    configureProtectedExecutionTls(true);
    configureProtectedExecutionProxyStarter(() => ({
      childEnv: Object.freeze({ AGENT_TOKEN: sentinel }),
      proxyEnv: Object.freeze({ HTTPS_PROXY: 'http://127.0.0.1:43123' }),
      port: 43123,
      close: async () => {
        closeCalls += 1;
      }
    }));
    configureSandboxLauncher(protectedLauncher());
    const cfg = createDefaultConfig('Test');
    cfg.agent.agents = [
      {
        id: AGENT_A,
        name: 'Agent A',
        capabilities: [],
        credentialIds: [],
        declaredScopes: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        atoms: { mode: 'inherit', allow: [], deny: [] },
        visibility: { subagentCallable: false, public: false },
        a2a: { enabled: false },
        monadix: { consume: false }
      },
      {
        id: AGENT_B,
        name: 'Agent B',
        capabilities: [],
        credentialIds: [],
        declaredScopes: [],
        memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 },
        atoms: { mode: 'inherit', allow: [], deny: [] },
        visibility: { subagentCallable: false, public: false },
        a2a: { enabled: false },
        monadix: { consume: false }
      }
    ];
    const handlers = buildHandlers(mockModel(['ok']), undefined, {
      configManager: stubConfigAccess(cfg, emptyAuth())
    });
    const { sessionId } = await handlers.session.create({ title: 'protected rebind', agentId: AGENT_A });
    const ctxA: ToolContext = { sessionId, agentId: AGENT_A, sandboxRoots: undefined, log: () => {} };
    const ctxB: ToolContext = { sessionId, agentId: AGENT_B, sandboxRoots: undefined, log: () => {} };
    const command = terminalMode === 'pty' ? 'printf ready; cat' : 'printf "$AGENT_TOKEN"; sleep 30';
    const started = await shellExecTool.run({ command, mode: 'background', terminalMode }, ctxA);
    const processId = started.metadata.processId;

    const beforeRebindList = await processControlTool.run({ action: 'list' }, ctxB);
    expect('processes' in beforeRebindList.metadata ? beforeRebindList.metadata.processes : []).toEqual([]);
    await expect(processControlTool.run({ action: 'logs', id: processId }, ctxB)).rejects.toThrow('unknown process');
    await expect(processControlTool.run({ action: 'wait', id: processId, timeoutMs: 1 }, ctxB)).rejects.toThrow(
      'unknown process'
    );
    await expect(
      processControlTool.run({ action: 'write', id: processId, input: 'use $AGENT_TOKEN\n' }, ctxB)
    ).rejects.toThrow('unknown process');
    await expect(
      processControlTool.run({ action: 'resize', id: processId, cols: 100, rows: 40 }, ctxB)
    ).rejects.toThrow('unknown process');
    await expect(processControlTool.run({ action: 'signal', id: processId, signal: 'SIGINT' }, ctxB)).rejects.toThrow(
      'unknown process'
    );
    await expect(processControlTool.run({ action: 'stop', id: processId }, ctxB)).rejects.toThrow('unknown process');

    await handlers.session.update({ id: sessionId, agentId: AGENT_B });

    expect(closeCalls).toBe(1);
    expect((await handlers.session.get({ id: sessionId })).session.agentIds).toEqual([AGENT_B]);
    const listed = await processControlTool.run({ action: 'list' }, ctxB);
    expect('processes' in listed.metadata ? listed.metadata.processes : []).toEqual([]);
    await expect(processControlTool.run({ action: 'logs', id: processId }, ctxB)).rejects.toThrow('unknown process');
    await expect(
      processControlTool.run({ action: 'write', id: processId, input: 'use $AGENT_TOKEN\n' }, ctxB)
    ).rejects.toThrow('unknown process');
    await expect(processControlTool.run({ action: 'stop', id: processId }, ctxB)).rejects.toThrow('unknown process');
  }
);
