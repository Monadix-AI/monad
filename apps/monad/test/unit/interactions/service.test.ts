import type { InteractionPresenterCapabilities, InteractionRequest, InteractionSource } from '@monad/protocol';

import { describe, expect, test } from 'bun:test';

import { redactInteractionRequest } from '#/interactions/redact';
import { HostInteractionError, HostInteractionService } from '#/interactions/service';

const source: InteractionSource = {
  kind: 'atom-pack',
  packId: 'example.pack',
  atomId: 'configure'
};

const confirmRequest: InteractionRequest = {
  type: 'confirm',
  title: 'Enable backend?'
};

const secretRequest: InteractionRequest = {
  type: 'form',
  title: 'Configure backend',
  fields: [
    { id: 'endpoint', type: 'string', label: 'Endpoint' },
    { id: 'apiKey', type: 'secret', label: 'API key', required: true }
  ]
};

const fullCapabilities: InteractionPresenterCapabilities = {
  interactionTypes: ['confirm', 'select', 'form'],
  fieldTypes: ['string', 'secret', 'number', 'boolean', 'select'],
  supportsSecretInput: true,
  supportsBackgroundQueue: true
};

function createHarness(options?: { leaseTtlMs?: number; maxPendingPerSource?: number }) {
  let now = Date.parse('2026-07-13T08:00:00.000Z');
  let nextId = 0;
  let nextToken = 0;
  const service = new HostInteractionService({
    now: () => now,
    createId: () => `interaction-${++nextId}`,
    createLeaseToken: () => `lease-${++nextToken}`,
    leaseTtlMs: options?.leaseTtlMs ?? 5_000,
    maxPendingPerSource: options?.maxPendingPerSource
  });

  return {
    service,
    advance(ms: number) {
      now += ms;
    }
  };
}

describe('HostInteractionService', () => {
  test('reserves a foreground request for its preferred presenter until it disconnects', () => {
    const { service } = createHarness();
    void service.request(source, confirmRequest, {
      mode: 'foreground',
      preferredPresenterId: 'web-1'
    });

    expect(() => service.claim('interaction-1', 'web-2', fullCapabilities)).toThrow(
      new HostInteractionError('presenter_not_preferred', 'Interaction is reserved for its preferred presenter')
    );

    const preferredClaim = service.claim('interaction-1', 'web-1', fullCapabilities);
    expect(preferredClaim.leaseToken).toBe('lease-1');

    service.releasePresenter('web-1');
    const fallbackClaim = service.claim('interaction-1', 'web-2', fullCapabilities);
    expect(fallbackClaim.leaseToken).toBe('lease-2');
  });

  test('keeps background requests queued and refuses presenters without queue support', () => {
    const { service } = createHarness();
    void service.request(source, confirmRequest, { mode: 'background' });

    expect(service.listPending()).toEqual([expect.objectContaining({ id: 'interaction-1', state: 'pending' })]);
    expect(() =>
      service.claim('interaction-1', 'cli-1', {
        ...fullCapabilities,
        supportsBackgroundQueue: false
      })
    ).toThrow(new HostInteractionError('incompatible_presenter', 'Presenter cannot claim background interactions'));
  });

  test('refuses a presenter that cannot render the entire request', () => {
    const { service } = createHarness();
    void service.request(source, secretRequest, { mode: 'background' });

    expect(() =>
      service.claim('interaction-1', 'tui-1', {
        interactionTypes: ['form'],
        fieldTypes: ['string', 'secret'],
        supportsSecretInput: false,
        supportsBackgroundQueue: true
      })
    ).toThrow(new HostInteractionError('incompatible_presenter', 'Presenter cannot safely collect secrets'));
  });

  test('grants one exclusive lease and makes it claimable after lease expiry', () => {
    const { service, advance } = createHarness({ leaseTtlMs: 1_000 });
    void service.request(source, confirmRequest, { mode: 'background' });

    service.claim('interaction-1', 'web-1', fullCapabilities);
    expect(service.listPending()[0]?.state).toBe('claimed');
    expect(() => service.claim('interaction-1', 'web-2', fullCapabilities)).toThrow(
      new HostInteractionError('already_claimed', 'Interaction is already claimed')
    );

    advance(1_001);
    const secondClaim = service.claim('interaction-1', 'web-2', fullCapabilities);
    expect(secondClaim.leaseToken).toBe('lease-2');
  });

  test('submits exactly once and removes the resolver before exposing the result', async () => {
    const { service } = createHarness();
    const resultPromise = service.request(source, confirmRequest, { mode: 'background' });
    const { leaseToken } = service.claim('interaction-1', 'web-1', fullCapabilities);

    service.submit('interaction-1', leaseToken, { confirmed: true });

    expect(service.listPending()).toEqual([]);
    expect(await resultPromise).toEqual({ status: 'submitted', values: { confirmed: true } });
    expect(() => service.submit('interaction-1', leaseToken, { confirmed: false })).toThrow(
      new HostInteractionError('not_found', 'Interaction not found')
    );
  });

  test('cancels exactly once and rejects a stale lease token', async () => {
    const { service } = createHarness();
    const resultPromise = service.request(source, confirmRequest, { mode: 'background' });
    service.claim('interaction-1', 'web-1', fullCapabilities);

    expect(() => service.cancel('interaction-1', 'wrong-token', 'close')).toThrow(
      new HostInteractionError('invalid_lease', 'Interaction lease is invalid')
    );
    service.cancel('interaction-1', 'lease-1', 'escape');

    expect(await resultPromise).toEqual({ status: 'cancelled', reason: 'escape' });
    expect(() => service.cancel('interaction-1', 'lease-1', 'close')).toThrow(
      new HostInteractionError('not_found', 'Interaction not found')
    );
  });

  test('times out pending requests deterministically', async () => {
    const { service, advance } = createHarness();
    const resultPromise = service.request(source, { ...confirmRequest, timeoutMs: 1_000 }, { mode: 'background' });

    advance(1_001);
    service.sweepExpired();

    expect(service.listPending()).toEqual([]);
    expect(await resultPromise).toEqual({ status: 'cancelled', reason: 'timeout' });
  });

  test('releases all presenter claims without retaining input drafts', () => {
    const { service } = createHarness();
    void service.request(source, secretRequest, { mode: 'background' });
    service.claim('interaction-1', 'web-1', fullCapabilities);

    service.releasePresenter('web-1');

    expect(service.listPending()).toEqual([expect.objectContaining({ id: 'interaction-1', state: 'pending' })]);
    expect(JSON.stringify(service.listPending())).not.toContain('secret-value');
    expect(service.claim('interaction-1', 'tui-1', fullCapabilities).leaseToken).toBe('lease-2');
  });

  test('limits pending requests to three per trusted source', async () => {
    const { service } = createHarness();
    void service.request(source, confirmRequest, { mode: 'background' });
    void service.request(source, confirmRequest, { mode: 'background' });
    void service.request(source, confirmRequest, { mode: 'background' });

    await expect(service.request(source, confirmRequest, { mode: 'background' })).rejects.toEqual(
      new HostInteractionError('source_limit', 'Interaction source already has 3 pending requests')
    );
  });

  test('returns allowlisted pending views without caller-owned properties or secret values', () => {
    const request = {
      ...secretRequest,
      injected: '<script>run()</script>',
      fields: [secretRequest.fields[0], { ...secretRequest.fields[1], value: 'secret-value', configured: true }]
    } as InteractionRequest;

    const redacted = redactInteractionRequest(request);

    expect(redacted).toEqual(secretRequest);
    expect(JSON.stringify(redacted)).not.toContain('secret-value');
    expect(JSON.stringify(redacted)).not.toContain('injected');
  });

  test('publishes redacted lifecycle events and never submitted values', async () => {
    const { service } = createHarness();
    const events: unknown[] = [];
    const unsubscribe = service.subscribe((event) => events.push(event));
    const resultPromise = service.request(source, secretRequest, { mode: 'background' });
    service.claim('interaction-1', 'web-1', fullCapabilities);
    service.submit('interaction-1', 'lease-1', { apiKey: 'secret-value' });
    await resultPromise;
    unsubscribe();

    expect(events.map((event) => (event as { type: string }).type)).toEqual(['upsert', 'upsert', 'removed']);
    expect(JSON.stringify(events)).not.toContain('secret-value');
  });
});
