import type { ProtectedCredential, SandboxLauncher } from '@monad/sandbox';
import type { ToolContext } from '#/capabilities/tools/types.ts';

import { afterEach, expect, test } from 'bun:test';
import { createDefaultConfig, emptyAuth } from '@monad/environment';

import {
  clearProcesses,
  configureProtectedCredentialResolver,
  configureProtectedExecutionProxyStarter,
  configureProtectedExecutionTls,
  configureSandboxLauncher,
  noneLauncher,
  processControlTool,
  shellExecTool
} from '#/capabilities/tools';
import { buildHandlers, mockModel, stubConfigAccess } from '../../helpers.ts';

const credential: ProtectedCredential = {
  environmentVariable: 'AGENT_TOKEN',
  secret: 'protected-rebind-secret',
  allowedHosts: ['api.example.com']
};
const sentinel = 'fake_value_00000000-0000-4000-8000-000000000006';
const AGENT_A = 'agt_0000000000A1' as const;
const AGENT_B = 'agt_0000000000B2' as const;

function protectedLauncher(): SandboxLauncher {
  return {
    kind: 'protected-local',
    descriptor: { name: 'Protected local' },
    enforces: { readDeny: true, net: ['filtered'] },
    wrap: (argv) => argv
  };
}

afterEach(() => {
  configureProtectedCredentialResolver(undefined);
  configureProtectedExecutionProxyStarter(undefined);
  configureProtectedExecutionTls(false);
  configureSandboxLauncher(noneLauncher);
  clearProcesses();
});

test.each(['pipe', 'pty'] as const)(
  'session rebind terminates agent A protected %s process before agent B can observe or control it',
  async (terminalMode) => {
    let closeCalls = 0;
    configureProtectedCredentialResolver(async () => ({
      credentials: [credential],
      credentialVaultContainsSecrets: true
    }));
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

    const beforeRebind = await processControlTool.run({ action: 'list' }, ctxB);
    expect('processes' in beforeRebind.metadata ? beforeRebind.metadata.processes : []).toEqual([]);
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

    const listed = await processControlTool.run({ action: 'list' }, ctxB);
    expect({
      closeCalls,
      agentIds: (await handlers.session.get({ id: sessionId })).session.agentIds,
      processes: 'processes' in listed.metadata ? listed.metadata.processes : []
    }).toEqual({ closeCalls: 1, agentIds: [AGENT_B], processes: [] });
    await expect(processControlTool.run({ action: 'logs', id: processId }, ctxB)).rejects.toThrow('unknown process');
    await expect(
      processControlTool.run({ action: 'write', id: processId, input: 'use $AGENT_TOKEN\n' }, ctxB)
    ).rejects.toThrow('unknown process');
    await expect(processControlTool.run({ action: 'stop', id: processId }, ctxB)).rejects.toThrow('unknown process');
  }
);
