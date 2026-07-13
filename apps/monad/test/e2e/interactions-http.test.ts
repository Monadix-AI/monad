import type { InteractionRequest, InteractionResult } from '@monad/protocol';
import type { AtomPackContext, ManifestAtomPack } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { loadChannelAtomPacks } from '#/channels/atom-pack-host.ts';
import { HostInteractionService } from '#/interactions/service.ts';
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
  expect(eventResponse.headers.get('content-type')).toContain('text/event-stream');
  expect(firstEventText).toContain('interaction-http-1');
  expect(firstEventText).not.toContain('secret-value');
  await eventReader?.cancel();

  const listed = await call('/v1/interactions');
  const listedText = await listed.text();
  expect(listed.status).toBe(200);
  expect(listedText).not.toContain('secret-value');
  expect(JSON.parse(listedText)).toMatchObject({
    interactions: [
      {
        id: 'interaction-http-1',
        source: { kind: 'atom-pack', packId: 'installed-contributed-backend', atomId: 'pack' },
        state: 'pending'
      }
    ]
  });

  const claimed = await call(
    '/v1/interactions/interaction-http-1/claim',
    json('POST', { presenterId: 'web-1', capabilities })
  );
  const claimedText = await claimed.text();
  expect(claimed.status).toBe(200);
  expect(claimedText).not.toContain('secret-value');
  expect(JSON.parse(claimedText)).toMatchObject({
    leaseToken: 'lease-http-1',
    interaction: { id: 'interaction-http-1', state: 'claimed' }
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
  expect(submittedText).not.toContain('secret-value');
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
  expect(await duplicate.json()).toMatchObject({ code: 'not_found' });
});
