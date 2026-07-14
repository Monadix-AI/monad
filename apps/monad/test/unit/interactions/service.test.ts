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

    expect(service.listPending()).toEqual([
      expect.objectContaining({ id: 'interaction-1', mode: 'background', state: 'pending' })
    ]);
    expect(() =>
      service.claim('interaction-1', 'cli-1', {
        ...fullCapabilities,
        supportsBackgroundQueue: false
      })
    ).toThrow(new HostInteractionError('incompatible_presenter', 'Presenter cannot claim background interactions'));
  });

  test('rejects interaction patterns with catastrophic backtracking risk', async () => {
    const { service } = createHarness();

    const result = service.request(
      source,
      {
        type: 'form',
        title: 'Unsafe validation',
        fields: [{ id: 'value', type: 'string', label: 'Value', pattern: '(a|aa)+$' }]
      },
      { mode: 'background' }
    );
    const outcome = await Promise.race([result.catch((error: unknown) => error), Bun.sleep(0)]);
    const pending = service.listPending()[0];
    if (pending) {
      const claim = service.claim(pending.id, 'web-1', fullCapabilities);
      service.cancel(pending.id, claim.leaseToken, 'close');
    }

    expect(outcome).toEqual(
      new HostInteractionError('unsafe_pattern', 'Interaction field "value" uses an unsafe validation pattern')
    );
    expect(service.listPending()).toEqual([]);
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

  test('renews an active lease while a presenter is collecting input', () => {
    const { service, advance } = createHarness({ leaseTtlMs: 1_000 });
    void service.request(source, confirmRequest, { mode: 'foreground' });
    const { leaseToken } = service.claim('interaction-1', 'web-1', fullCapabilities);

    advance(750);
    service.renew('interaction-1', leaseToken);
    advance(750);

    expect(() => service.submit('interaction-1', leaseToken, { confirmed: true })).not.toThrow();
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

  test('rejects submitted values that do not satisfy the stored request', async () => {
    const { service } = createHarness();
    const resultPromise = service.request(source, secretRequest, { mode: 'background' });
    const { leaseToken } = service.claim('interaction-1', 'web-1', fullCapabilities);

    expect(() => service.submit('interaction-1', leaseToken, { apiKey: 42, injected: true })).toThrow(
      new HostInteractionError('invalid_submission', 'Interaction field "apiKey" must be a string')
    );
    expect(service.listPending()).toEqual([expect.objectContaining({ id: 'interaction-1', state: 'claimed' })]);

    service.submit('interaction-1', leaseToken, { apiKey: 'secret-value' });
    expect(await resultPromise).toEqual({ status: 'submitted', values: { apiKey: 'secret-value' } });
  });

  test('bounds strings before evaluating accepted validation patterns', async () => {
    const { service } = createHarness();
    const resultPromise = service.request(
      source,
      {
        type: 'form',
        title: 'Validate value',
        fields: [{ id: 'value', type: 'string', label: 'Value', pattern: '^[a-z]+$' }]
      },
      { mode: 'background' }
    );
    const { leaseToken } = service.claim('interaction-1', 'web-1', fullCapabilities);

    expect(() => service.submit('interaction-1', leaseToken, { value: 'a'.repeat(4_097) })).toThrow(
      new HostInteractionError('invalid_submission', 'Interaction field "value" is too long for pattern validation')
    );
    service.submit('interaction-1', leaseToken, { value: 'safe' });
    expect(await resultPromise).toEqual({ status: 'submitted', values: { value: 'safe' } });
  });

  test('rejects undeclared select values and false confirmations', () => {
    const { service } = createHarness();
    void service.request(source, confirmRequest, { mode: 'background' });
    const confirmLease = service.claim('interaction-1', 'web-1', fullCapabilities).leaseToken;
    expect(() => service.submit('interaction-1', confirmLease, { confirmed: false })).toThrow(
      new HostInteractionError('invalid_submission', 'Confirmation must be explicitly accepted')
    );

    void service.request(
      source,
      {
        type: 'select',
        title: 'Choose a backend',
        options: [{ label: 'Local', value: 'local' }]
      },
      { mode: 'background' }
    );
    const selectLease = service.claim('interaction-2', 'web-1', fullCapabilities).leaseToken;
    expect(() => service.submit('interaction-2', selectLease, { value: 'remote' })).toThrow(
      new HostInteractionError('invalid_submission', 'Selection must be one of the declared options')
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
