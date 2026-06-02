import type { MonadPaths } from '@monad/environment';
import type { ModelResult, ModelRouter } from '#/agent/index.ts';
import type { KvService } from '#/services/kv.ts';
import type { DataLayer } from '#/store/lifecycle.ts';
import type { TransportKind } from '../helpers.ts';

import { expect } from 'bun:test';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initMonadHome } from '@monad/environment';

import {
  configureProtectedExecutionProxyStarter,
  configureSandboxLauncher,
  noneLauncher,
  shellExecTool
} from '#/capabilities/tools';
import { createSandboxLifecycleModule } from '#/platform/sandbox/lifecycle.ts';
import { RuntimeContext } from '#/runtime/context.ts';
import { createStore } from '#/store/db/index.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, createTestConfigManager, makeTestPaths, serveTransport } from '../helpers.ts';

const secret = 'transport-real-secret-canary';

function scriptedShellModel(command: string): ModelRouter {
  let turn = 0;
  return {
    async *stream() {},
    async complete(): Promise<ModelResult> {
      turn += 1;
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [{ toolCallId: 'tc_credential', toolName: 'shell_exec', input: { command } }],
          finishReason: 'tool-calls'
        };
      }
      return { text: 'done', finishReason: 'stop' };
    }
  };
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  };
}

export async function runAgentCredentialExecution(kind: TransportKind): Promise<void> {
  const dir = join(tmpdir(), `monad-agent-credential-execution-${kind}-${crypto.randomUUID()}`);
  const paths: MonadPaths = makeTestPaths(dir);
  const output = join(dir, 'child-output.txt');
  await initMonadHome(paths);
  const configManager = await createTestConfigManager(paths);
  await configManager.updateConfig((cfg) => {
    cfg.sandbox.confine = true;
    cfg.sandbox.net = 'none';
    cfg.sandbox.tlsTerminate.enabled = true;
  });
  configureProtectedExecutionProxyStarter(undefined);
  const store = createStore();
  const context = new RuntimeContext();
  context.commit('store', {
    kv: {} as KvService,
    store,
    stop: async () => store.close()
  } satisfies DataLayer);
  const lifecycle = createSandboxLifecycleModule({
    initial: configManager.get(),
    paths,
    config: () => configManager
  });
  const sandbox = await lifecycle.start(context, new AbortController().signal);
  configureSandboxLauncher({
    kind: 'transport-protected-local',
    descriptor: { name: 'Transport protected local' },
    enforces: { readDeny: true, net: ['none', 'filtered'] },
    wrap: (argv) => argv
  });
  const command = `printf '%s|%s' "$AGENT_TOKEN" "$HTTPS_PROXY" > ${JSON.stringify(output)}`;
  const transport = serveTransport(
    kind,
    createHttpTransport(
      buildHandlers(scriptedShellModel(command), undefined, {
        configManager,
        store,
        tools: [shellExecTool],
        agentSandboxRoots: () => [dir]
      })
    )
  );

  try {
    let response = await transport.fetch(
      '/v1/settings/credentials',
      json('POST', {
        label: 'Transport Credential',
        environmentVariable: 'AGENT_TOKEN',
        secret,
        allowedHosts: ['api.example.com']
      })
    );
    expect(response.status).toBe(201);
    const credentialId = ((await response.json()) as { id: string }).id;

    response = await transport.fetch(
      '/v1/agents',
      json('POST', { name: 'Transport Credential Agent', credentialIds: [credentialId] })
    );
    expect(response.status).toBe(201);
    const agentId = ((await response.json()) as { agent: { id: string } }).agent.id;

    response = await transport.fetch('/v1/sessions', json('POST', { title: 'credential execution', agentId }));
    expect(response.status).toBe(201);
    const sessionId = ((await response.json()) as { sessionId: string }).sessionId;

    response = await transport.fetch(
      `/v1/sessions/${sessionId}/messages/block`,
      json('POST', { text: 'Use the granted credential.' })
    );
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: {
        message: expect.objectContaining({ role: 'assistant', text: 'done' })
      }
    });

    const childOutput = await Bun.file(output).text();
    const [childToken, childProxy] = childOutput.split('|');
    expect(childToken).toMatch(/^fake_value_[0-9a-f-]+$/);
    expect(childProxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(childOutput).not.toContain(secret);
  } finally {
    await transport.stop();
    await lifecycle.stop?.(sandbox, context);
    configureSandboxLauncher(noneLauncher);
    configureProtectedExecutionProxyStarter(undefined);
    store.close();
    await configManager.stop();
    await rm(dir, { recursive: true, force: true });
  }
}
