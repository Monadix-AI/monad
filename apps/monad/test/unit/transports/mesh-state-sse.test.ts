import type { MeshAgentStateFrame, SessionId } from '@monad/protocol';

import { expect, test } from 'bun:test';
import { newId } from '@monad/protocol';

import { createDaemonHandlers } from '#/handlers/daemon-handlers/index.ts';
import { createSessionMeshStateSseResponse } from '#/transports/http/sessions/stream.ts';

test('a mesh-state bootstrap overflow closes the SSE so the client can reconnect', async () => {
  let disposed = 0;
  const handlers = {
    session: {
      resolveMeshStateAnchor: () => {},
      subscribeMeshState: (_args: { sessionId: SessionId }, _sink: (frame: MeshAgentStateFrame) => void) => ({
        subscribed: true as const,
        dispose: () => {
          disposed += 1;
        },
        pump: () => 'overflow' as const
      })
    }
  } as unknown as ReturnType<typeof createDaemonHandlers>;
  const response = await createSessionMeshStateSseResponse({
    handlers,
    sessionId: newId('ses') as SessionId,
    encoder: new TextEncoder()
  });
  const reader = response.body?.getReader();
  if (!reader) throw new Error('mesh-state response has no body');

  const result = await reader.read();

  expect({ done: result.done, disposed }).toEqual({ done: true, disposed: 1 });
});
