import { expect, test } from 'bun:test';

import { createMeshAgentController } from '#/transports/http/mesh-agent.ts';

const transcriptTargetId = 'ses_vNS1ntNNeY6S';

test('aborting a raw observation request disposes its upstream subscription', async () => {
  let disposed = 0;
  const handlers = {
    meshAgent: {
      subscribeRawObservation: () => ({
        frames: [],
        live: true,
        dispose: () => disposed++
      })
    }
  };
  const request = new AbortController();
  const app = createMeshAgentController(handlers as never);
  const response = await app.handle(
    new Request(`http://localhost/mesh/sessions/member/stream/raw?transcriptTargetId=${transcriptTargetId}`, {
      signal: request.signal
    })
  );

  request.abort();
  await Bun.sleep(0);

  expect({ status: response.status, disposed }).toEqual({ status: 200, disposed: 1 });
});

test('aborting a convenience observation request disposes its upstream subscription', async () => {
  let disposed = 0;
  const handlers = {
    meshAgent: {
      subscribeConvenienceObservation: () => ({
        frames: [],
        live: true,
        dispose: () => disposed++
      })
    }
  };
  const request = new AbortController();
  const app = createMeshAgentController(handlers as never);
  const response = await app.handle(
    new Request(`http://localhost/mesh/sessions/member/stream/convenience?transcriptTargetId=${transcriptTargetId}`, {
      signal: request.signal
    })
  );

  request.abort();
  await Bun.sleep(0);

  expect({ status: response.status, disposed }).toEqual({ status: 200, disposed: 1 });
});
