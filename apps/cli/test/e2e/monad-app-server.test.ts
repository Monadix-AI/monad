import type { MonadAppServerNotification, MonadAppServerResponse, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonadClient } from '@monad/client';
import { createDefaultConfig, saveAll } from '@monad/environment';
import { newId } from '@monad/protocol';

import { ModelService } from '../../../monad/src/handlers/settings/model/index.ts';
import { createHttpTransport } from '../../../monad/src/transports/http.ts';
import { buildHandlers, makeTestPaths, mockModel, seededProviderRegistry } from '../../../monad/test/helpers.ts';
import { createMonadAppServerHttpClient } from '../../src/app-server/bridge.ts';
import { createMonadAppServerConnection } from '../../src/app-server/connection.ts';

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for Monad app-server event');
    await Bun.sleep(10);
  }
}

test('Monad app-server executes and resumes a Studio agent through shared Unix HTTP and SSE', async () => {
  const home = await mkdtemp(join(tmpdir(), 'monad-appsrv-home-'));
  const paths = makeTestPaths(home);
  const agentId = newId('agt');
  const config = createDefaultConfig('app-server-e2e');
  config.agent.agents.push({
    id: agentId,
    name: 'App Server Agent',
    capabilities: [],
    credentialIds: [],
    declaredScopes: [],
    atoms: { mode: 'inherit', allow: [], deny: [] },
    visibility: { subagentCallable: false, public: false },
    a2a: { enabled: false },
    monadix: { consume: false },
    memory: { enabled: true, advanced: true, autoConsolidate: false, intervalMinutes: 30 }
  });
  config.agent.defaultAgentId = agentId;
  await saveAll(paths, config);
  const modelService = new ModelService(paths.auth, config, null, seededProviderRegistry());
  const handlers = buildHandlers(mockModel(), { paths, modelService });
  const app = createHttpTransport(handlers);
  const socket = join(tmpdir(), `monad-appsrv-${process.pid}-${Date.now()}.sock`);
  const server = Bun.serve({ unix: socket, fetch: (request) => app.handle(request) }) as unknown as {
    stop(force?: boolean): void;
  };
  const client = new MonadClient({ baseUrl: 'http://localhost', unixSocket: socket });
  const httpClient = createMonadAppServerHttpClient(client);
  const output: Array<MonadAppServerNotification | MonadAppServerResponse> = [];
  const connection = createMonadAppServerConnection({ client: httpClient, write: (message) => output.push(message) });

  try {
    await connection.handleLine(
      JSON.stringify({
        kind: 'request',
        id: '1',
        method: 'session/open',
        params: { agentId, cwd: tmpdir() }
      })
    );
    const opened = output.find(
      (message): message is Extract<MonadAppServerResponse, { method: 'session/open'; result: unknown }> =>
        message.kind === 'response' && message.method === 'session/open' && 'result' in message
    );
    if (!opened) throw new Error('session/open did not return a response');
    const sessionId = opened.result.sessionId;

    await connection.handleLine(
      JSON.stringify({
        kind: 'request',
        id: '2',
        method: 'turn/start',
        params: { sessionId, input: { text: 'hello', attachments: [] } }
      })
    );
    await eventually(() =>
      output.some(
        (message) =>
          message.kind === 'notification' &&
          message.method === 'session/event' &&
          message.params.event.type === 'session.message.completed'
      )
    );
    await connection.handleLine(
      JSON.stringify({ kind: 'request', id: '3', method: 'session/close', params: { sessionId } })
    );

    const resumed: Array<MonadAppServerNotification | MonadAppServerResponse> = [];
    const resumeConnection = createMonadAppServerConnection({
      client: httpClient,
      write: (message) => resumed.push(message)
    });
    await resumeConnection.handleLine(
      JSON.stringify({
        kind: 'request',
        id: '4',
        method: 'session/open',
        params: { agentId, cwd: tmpdir(), providerSessionRef: sessionId }
      })
    );
    await resumeConnection.close();

    expect(handlers.store.listMessages(sessionId as SessionId).map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'Hello from the mock model.' }
    ]);
    expect(resumed.slice(0, 2)).toEqual([
      { kind: 'response', id: '4', method: 'session/open', result: { sessionId } },
      { kind: 'notification', method: 'session/identified', params: { sessionId } }
    ]);
  } finally {
    await connection.close();
    client.dispose();
    server.stop(true);
    handlers.store.close();
    await unlink(socket).catch(() => {});
    await rm(home, { recursive: true, force: true });
  }
});
