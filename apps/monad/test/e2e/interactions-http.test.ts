import type { InteractionRequest, InteractionResult } from '@monad/protocol';
import type { AtomPackContext, ManifestAtomPack } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { loadChannelAtomPacks } from '#/channels/atom-pack-host.ts';
import { HostInteractionService } from '#/interactions/service.ts';
import { createInteractionsController } from '#/transports/http/interactions.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

const capabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
} as const;

const request: InteractionRequest = {
  type: 'form',
  title: 'Configure contributed backend',
  fields: [
    { id: 'endpoint', type: 'string', label: 'Endpoint' },
    { id: 'apiKey', type: 'secret', label: 'API key', required: true }
  ]
};

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

interface SseTestReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
}

async function readTextChunk(reader: SseTestReader, timeoutMs = 100): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE chunk')), timeoutMs))
  ]);
  return new TextDecoder().decode(result.value);
}

function parseInteractionEventChunk(text: string): unknown {
  const lines = text.trimEnd().split('\n');
  expect(lines[0]).toBe('event: interaction');
  const dataLine = lines[1];
  if (!dataLine) throw new Error(`missing interaction event data line: ${text}`);
  expect(dataLine).toStartWith('data: ');
  return JSON.parse(dataLine.slice('data: '.length));
}

test('interaction event stream sends heartbeat comments while idle', async () => {
  const service = new HostInteractionService();
  const app = createInteractionsController(service, { heartbeatMs: 10 });
  const response = await app.handle(new Request('http://localhost/interactions/events'));
  const reader = response.body?.getReader();
  if (!reader) throw new Error('missing SSE response body');

  const first = await readTextChunk(reader);
  const second = await readTextChunk(reader);

  expect(first).toBe(': connected\n\n');
  expect(second).toBe(': keepalive\n\n');
  await reader?.cancel();
});

test('atom interaction can be claimed and completed once over HTTP without echoing secrets', async () => {
  let requestFromAtom: AtomPackContext['requestInteraction'] | undefined;
  const atomPack: ManifestAtomPack = {
    manifest: {
      name: 'contributed-backend',
      version: '1.0.0',
      sdkVersion: '0',
      atoms: []
    },
    register(ctx) {
      requestFromAtom = ctx.requestInteraction;
    }
  };
  const interactions = new HostInteractionService({
    now: () => 0,
    createId: () => 'interaction-http-1',
    createLeaseToken: () => 'lease-http-1'
  });

  await loadChannelAtomPacks([atomPack], {
    packIdFor: () => 'installed-contributed-backend',
    onRequestInteraction: (packId, interactionRequest) =>
      interactions.request({ kind: 'atom-pack', packId, atomId: 'pack' }, interactionRequest, { mode: 'background' })
  });
  expect(requestFromAtom).toBeFunction();

  const resultPromise = requestFromAtom?.(request) as Promise<InteractionResult>;
  const app = createHttpTransport(buildHandlers(mockModel()), { interactions });
  const call = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));

  const eventResponse = await call('/v1/interactions/events');
  const eventReader = eventResponse.body?.getReader();
  const firstEvent = await eventReader?.read();
  const firstEventText = new TextDecoder().decode(firstEvent?.value);
  expect(eventResponse.status).toBe(200);
  expect(eventResponse.headers.get('content-type')?.split(';')[0]).toBe('text/event-stream');
  expect(parseInteractionEventChunk(firstEventText)).toEqual({
    type: 'upsert',
    interaction: {
      id: 'interaction-http-1',
      source: { kind: 'atom-pack', packId: 'installed-contributed-backend', atomId: 'pack' },
      request: {
        type: 'form',
        title: 'Configure contributed backend',
        fields: [
          { id: 'endpoint', type: 'string', label: 'Endpoint' },
          { id: 'apiKey', type: 'secret', label: 'API key', required: true }
        ]
      },
      mode: 'background',
      state: 'pending',
      createdAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:05:00.000Z'
    }
  });
  await eventReader?.cancel();

  const listed = await call('/v1/interactions');
  const listedText = await listed.text();
  expect(listed.status).toBe(200);
  expect(JSON.parse(listedText)).toEqual({
    interactions: [
      {
        id: 'interaction-http-1',
        source: { kind: 'atom-pack', packId: 'installed-contributed-backend', atomId: 'pack' },
        request: {
          type: 'form',
          title: 'Configure contributed backend',
          fields: [
            { id: 'endpoint', type: 'string', label: 'Endpoint' },
            { id: 'apiKey', type: 'secret', label: 'API key', required: true }
          ]
        },
        mode: 'background',
        state: 'pending',
        createdAt: '1970-01-01T00:00:00.000Z',
        expiresAt: '1970-01-01T00:05:00.000Z'
      }
    ]
  });

  const claimed = await call(
    '/v1/interactions/interaction-http-1/claim',
    json('POST', { presenterId: 'web-1', capabilities })
  );
  const claimedText = await claimed.text();
  expect(claimed.status).toBe(200);
  expect(JSON.parse(claimedText)).toEqual({
    leaseToken: 'lease-http-1',
    interaction: {
      id: 'interaction-http-1',
      source: { kind: 'atom-pack', packId: 'installed-contributed-backend', atomId: 'pack' },
      request: {
        type: 'form',
        title: 'Configure contributed backend',
        fields: [
          { id: 'endpoint', type: 'string', label: 'Endpoint' },
          { id: 'apiKey', type: 'secret', label: 'API key', required: true }
        ]
      },
      mode: 'background',
      state: 'claimed',
      createdAt: '1970-01-01T00:00:00.000Z',
      expiresAt: '1970-01-01T00:05:00.000Z'
    }
  });

  const renewed = await call('/v1/interactions/interaction-http-1/renew', json('POST', { leaseToken: 'lease-http-1' }));
  expect(renewed.status).toBe(200);
  expect(await renewed.json()).toEqual({ ok: true });

  const invalidSubmission = await call(
    '/v1/interactions/interaction-http-1/submit',
    json('POST', { leaseToken: 'lease-http-1', values: { apiKey: 42 } })
  );
  expect(invalidSubmission.status).toBe(400);
  expect(await invalidSubmission.json()).toEqual({
    error: 'Interaction field "apiKey" must be a string',
    code: 'invalid_submission'
  });

  const submitted = await call(
    '/v1/interactions/interaction-http-1/submit',
    json('POST', {
      leaseToken: 'lease-http-1',
      values: { endpoint: 'https://example.test', apiKey: 'secret-value' }
    })
  );
  const submittedText = await submitted.text();
  expect(submitted.status).toBe(200);
  expect(JSON.parse(submittedText)).toEqual({ ok: true });
  expect(await resultPromise).toEqual({
    status: 'submitted',
    values: { endpoint: 'https://example.test', apiKey: 'secret-value' }
  });

  const duplicate = await call(
    '/v1/interactions/interaction-http-1/submit',
    json('POST', { leaseToken: 'lease-http-1', values: { apiKey: 'another-secret' } })
  );
  expect(duplicate.status).toBe(404);
  expect(await duplicate.json()).toEqual({ error: 'Interaction not found', code: 'not_found' });
});
