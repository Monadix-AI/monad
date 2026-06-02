// Validates that the interaction authority the atoms lifecycle threads to atom discovery — the object
// its `onRequestInteraction` capability calls `.request` on — is the same one the daemon HTTP plane
// reads. A request issued through the lifecycle-provided instance is listed, claimed, and submitted over
// HTTP, and the original caller's Promise resolves with the submitted result: behavioral flow across the
// boundary, not object equality. (The real AtomPackContext.requestInteraction adapter is exercised
// separately by interactions-http.test.ts; here the spy discover captures opts.interactions directly.)

import type { MonadPaths } from '@monad/environment';
import type { InteractionPresenterCapabilities, InteractionRequest } from '@monad/protocol';
import type { ModelSubsystem } from '#/agent/model/lifecycle.ts';
import type { AtomDiscovery } from '#/atoms/lifecycle.ts';
import type { ConfigSnapshot } from '#/config/manager.ts';
import type { EmbeddingIndexer } from '#/services/embedding-indexer.ts';
import type { ModelService } from '#/services/model.ts';
import type { ModelCatalogService } from '#/services/model-catalog.ts';

import { expect, test } from 'bun:test';
import { createDefaultConfig } from '@monad/environment';

import { createAtomsLifecycleModule } from '#/atoms/lifecycle.ts';
import { createAgentCapabilityRuntime } from '#/capabilities/lifecycle.ts';
import { InteractionService } from '#/interactions/service.ts';
import { RuntimeContext } from '#/runtime/context.ts';
import { createHttpTransport } from '#/transports/http.ts';
import { buildHandlers, mockModel } from '../helpers.ts';

const confirmRequest: InteractionRequest = { type: 'confirm', title: 'Allow?' };
const fullCapabilities: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  };
}

const emptyDiscovery: AtomDiscovery = {
  channelRegistry: new Map(),
  atomConflicts: [],
  atomDetailsByPack: new Map(),
  activeAtomPacks: new Map(),
  refreshWorkplaceExperienceSnapshot: async () => {},
  getWorkplaceExperienceSnapshot: () => undefined
};

test('an atom-lifecycle-wired interaction request is listed, claimed, and settled over the daemon HTTP plane', async () => {
  const interactions = new InteractionService({
    now: () => 0,
    createId: () => 'interaction-atom-1',
    createLeaseToken: () => 'lease-atom-1'
  });
  const initial: ConfigSnapshot = { cfg: createDefaultConfig('Test'), auth: null };
  const paths = { credentials: '/home/credentials' } as MonadPaths;
  const capabilities = createAgentCapabilityRuntime({ paths, sandboxRoots: ['/workspace'], tools: [] });
  const model = {
    modelService: {} as ModelService,
    modelCatalog: {} as ModelCatalogService,
    embeddingIndexer: {} as EmbeddingIndexer,
    stop: () => {}
  } satisfies ModelSubsystem;
  const context = new RuntimeContext();
  context.commit('capabilities', capabilities);
  context.commit('agent.model', model);

  // Capture the interaction authority the atoms module threads to atom discovery — the exact object
  // whose `.request` the onRequestInteraction capability invokes.
  let capabilityInteractions: InteractionService | undefined;
  const module = createAtomsLifecycleModule(
    { initial, paths, logger: { warn: () => {} }, interactions },
    async (opts) => {
      capabilityInteractions = opts.interactions;
      return emptyDiscovery;
    }
  );
  await module.start(context, new AbortController().signal);
  if (!capabilityInteractions) throw new Error('atoms lifecycle did not provide an interaction authority');

  // Issue the exact request an atom pack's onRequestInteraction capability makes, through that authority,
  // and keep its Promise so we can assert the caller is actually resolved when the turn settles.
  const resultPromise = capabilityInteractions.request(
    { kind: 'atom-pack', packId: 'demo', atomId: 'pack' },
    confirmRequest,
    { mode: 'background' }
  );

  // The daemon HTTP plane, built on the same authority, observes and settles it end to end.
  const app = createHttpTransport(buildHandlers(mockModel(), undefined, { interactions }));
  const call = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));

  const listed = await call('/v1/interactions');
  const listedBody = (await listed.json()) as { interactions: Array<{ id: string; state: string }> };
  expect(listedBody.interactions.map((i) => ({ id: i.id, state: i.state }))).toEqual([
    { id: 'interaction-atom-1', state: 'pending' }
  ]);

  const claimed = await call(
    '/v1/interactions/interaction-atom-1/claim',
    json('POST', { presenterId: 'web-1', capabilities: fullCapabilities })
  );
  expect(claimed.status).toBe(200);

  const submitted = await call(
    '/v1/interactions/interaction-atom-1/submit',
    json('POST', { leaseToken: 'lease-atom-1', values: { confirmed: true } })
  );
  expect(submitted.status).toBe(200);

  const afterSubmit = await call('/v1/interactions');
  const afterBody = (await afterSubmit.json()) as { interactions: unknown[] };
  // presence-ok: the request was submitted, so the HTTP plane no longer lists it.
  expect(afterBody.interactions).toEqual([]);

  // The atom caller's own Promise resolves with the submitted result — the HTTP submit settled the very
  // request the lifecycle authority issued, not just an active row somewhere.
  expect(await resultPromise).toEqual({ status: 'submitted', values: { confirmed: true } });
});
