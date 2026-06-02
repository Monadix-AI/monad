import type {
  ClarifyRespondRequest,
  ClarifyRespondResponse,
  Event,
  EventId,
  MeshAgentTurnInput,
  SessionId,
  ToolApproveRequest,
  ToolApproveResponse
} from '@monad/protocol';

import { createInterface } from 'node:readline';
import { MonadClient } from '@monad/client';
import { resolveClientConn } from '@monad/environment';
import {
  abortSessionResponseSchema,
  clarifyRespondResponseSchema,
  createSessionResponseSchema,
  getSessionResponseSchema,
  listAgentsResponseSchema,
  sendMessageResponseSchema,
  toolApproveResponseSchema
} from '@monad/protocol';

import { requireTreatyData } from '../lib/treaty.ts';
import { createMonadAppServerConnection, type MonadAppServerClient } from './connection.ts';

export function createMonadAppServerHttpClient(client: MonadClient): MonadAppServerClient {
  return {
    async openSession({ agentId, cwd, providerSessionRef, mcpServers }): Promise<SessionId> {
      let sessionId: SessionId;
      if (providerSessionRef) {
        const data = getSessionResponseSchema.parse(
          requireTreatyData(await client.treaty.v1.sessions({ id: providerSessionRef }).get())
        );
        if (!data.session.agentIds.includes(agentId)) {
          throw new Error(`Monad session ${providerSessionRef} is not bound to agent ${agentId}`);
        }
        sessionId = providerSessionRef;
      } else {
        sessionId = createSessionResponseSchema.parse(
          requireTreatyData(
            await client.treaty.v1.sessions.post({
              title: 'Monad MeshAgent',
              agentId,
              cwd,
              origin: { surface: 'api', client: 'monad-app-server' }
            })
          )
        ).sessionId;
      }
      if (mcpServers?.length) {
        requireTreatyData(
          await client.treaty.v1
            .sessions({ id: sessionId })
            .runtime.put({ mcpServers: mcpServers.map((server) => ({ ...server, transport: 'stdio' as const })) })
        );
      }
      return sessionId;
    },
    subscribeEvents(
      sessionId: SessionId,
      afterEventId: EventId | undefined,
      onEvent: (event: Event) => void,
      onError
    ): () => void {
      return client.streamEvents(sessionId, onEvent, { afterEventId, onError });
    },
    async sendTurn(sessionId: SessionId, input: MeshAgentTurnInput, steer: boolean): Promise<{ accepted: true }> {
      const attachments = input.attachments.map((attachment) => ({
        kind: 'file-meta' as const,
        name: attachment.name,
        mediaType: attachment.mime,
        size: attachment.bytes
      }));
      return sendMessageResponseSchema.parse(
        requireTreatyData(
          await client.treaty.v1.sessions({ id: sessionId }).messages.post({
            text: input.text,
            ...(attachments.length ? { attachments } : {}),
            ...(steer ? { steer: true } : {})
          })
        )
      );
    },
    async interrupt(sessionId: SessionId): Promise<{ ok: boolean }> {
      const result = abortSessionResponseSchema.parse(
        requireTreatyData(await client.treaty.v1.sessions({ id: sessionId }).abort.post())
      );
      return { ok: result.aborted };
    },
    async resolveApproval(input: ToolApproveRequest): Promise<ToolApproveResponse> {
      return toolApproveResponseSchema.parse(requireTreatyData(await client.treaty.v1.tools.approve.post(input)));
    },
    async respondClarify(input: ClarifyRespondRequest): Promise<ClarifyRespondResponse> {
      return clarifyRespondResponseSchema.parse(
        requireTreatyData(await client.treaty.v1.clarifications.respond.post(input))
      );
    }
  };
}

export function requireMonadAppServerUnixSocket(connection: { unixSocket?: string }): string {
  if (!connection.unixSocket) {
    throw new Error('Monad app-server requires the local daemon Unix-socket transport');
  }
  return connection.unixSocket;
}

export async function runMonadAppServer(options: { listAgents?: boolean } = {}): Promise<void> {
  const resolved = await resolveClientConn();
  const client = new MonadClient({
    baseUrl: resolved.baseUrl,
    token: resolved.token ?? undefined,
    unixSocket: requireMonadAppServerUnixSocket(resolved)
  });
  if (options.listAgents) {
    const agents = listAgentsResponseSchema.parse(requireTreatyData(await client.treaty.v1.agents.get()));
    process.stdout.write(`${JSON.stringify(agents)}\n`);
    client.dispose();
    return;
  }
  const connection = createMonadAppServerConnection({
    client: createMonadAppServerHttpClient(client),
    write(message) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    }
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (line.trim()) await connection.handleLine(line);
    }
  } finally {
    await connection.close();
    client.dispose();
  }
}
