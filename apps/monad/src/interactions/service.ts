import {
  type InteractionEvent,
  type InteractionPresenterCapabilities,
  type InteractionRequest,
  type InteractionResult,
  type InteractionSource,
  interactionPresenterCapabilitiesSchema,
  interactionRequestSchema,
  interactionSourceSchema,
  type PendingInteraction
} from '@monad/protocol';

import { projectPendingInteraction } from './redact';

export type InteractionRouting = {
  mode: 'foreground' | 'background';
  preferredPresenterId?: string;
};

export type InteractionCancellationReason = Extract<InteractionResult, { status: 'cancelled' }>['reason'];

export type HostInteractionErrorCode =
  | 'not_found'
  | 'source_limit'
  | 'presenter_not_preferred'
  | 'incompatible_presenter'
  | 'already_claimed'
  | 'invalid_lease';

export class HostInteractionError extends Error {
  constructor(
    readonly code: HostInteractionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'HostInteractionError';
  }
}

type Lease = {
  presenterId: string;
  token: string;
  expiresAt: number;
};

type PendingRecord = {
  id: string;
  source: InteractionSource;
  sourceKey: string;
  request: InteractionRequest;
  routing: InteractionRouting;
  createdAt: number;
  expiresAt: number;
  lease?: Lease;
  timeout?: ReturnType<typeof setTimeout>;
  resolve: (result: InteractionResult) => void;
};

export type HostInteractionServiceOptions = {
  now?: () => number;
  createId?: () => string;
  createLeaseToken?: () => string;
  defaultTimeoutMs?: number;
  leaseTtlMs?: number;
  maxPendingPerSource?: number;
};

function defaultId(): string {
  return `interaction-${crypto.randomUUID()}`;
}

function defaultLeaseToken(): string {
  return crypto.randomUUID();
}

function sourceKey(source: InteractionSource): string {
  return source.kind === 'builtin' ? `builtin:${source.id}` : `atom-pack:${source.packId}:${source.atomId}`;
}

function supportsRequest(
  request: InteractionRequest,
  routing: InteractionRouting,
  capabilities: InteractionPresenterCapabilities
): void {
  if (routing.mode === 'background' && !capabilities.supportsBackgroundQueue) {
    throw new HostInteractionError('incompatible_presenter', 'Presenter cannot claim background interactions');
  }
  if (!capabilities.interactionTypes.includes(request.type)) {
    throw new HostInteractionError('incompatible_presenter', `Presenter does not support ${request.type} interactions`);
  }
  if (request.type !== 'form') return;

  for (const field of request.fields) {
    if (!capabilities.fieldTypes.includes(field.type)) {
      throw new HostInteractionError('incompatible_presenter', `Presenter does not support ${field.type} fields`);
    }
    if (field.type === 'secret' && !capabilities.supportsSecretInput) {
      throw new HostInteractionError('incompatible_presenter', 'Presenter cannot safely collect secrets');
    }
  }
}

export class HostInteractionService {
  readonly #pending = new Map<string, PendingRecord>();
  readonly #listeners = new Set<(event: InteractionEvent) => void>();
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createLeaseToken: () => string;
  readonly #defaultTimeoutMs: number;
  readonly #leaseTtlMs: number;
  readonly #maxPendingPerSource: number;

  constructor(options: HostInteractionServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? defaultId;
    this.#createLeaseToken = options.createLeaseToken ?? defaultLeaseToken;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.#leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.#maxPendingPerSource = options.maxPendingPerSource ?? 3;
  }

  async request(
    untrustedSource: InteractionSource,
    untrustedRequest: InteractionRequest,
    routing: InteractionRouting = { mode: 'background' }
  ): Promise<InteractionResult> {
    const source = interactionSourceSchema.parse(untrustedSource);
    const request = interactionRequestSchema.parse(untrustedRequest);
    const key = sourceKey(source);
    const sourcePendingCount = [...this.#pending.values()].filter((record) => record.sourceKey === key).length;
    if (sourcePendingCount >= this.#maxPendingPerSource) {
      throw new HostInteractionError(
        'source_limit',
        `Interaction source already has ${this.#maxPendingPerSource} pending requests`
      );
    }

    const id = this.#createId();
    const createdAt = this.#now();
    const expiresAt = createdAt + (request.timeoutMs ?? this.#defaultTimeoutMs);

    return await new Promise<InteractionResult>((resolve) => {
      const record: PendingRecord = {
        id,
        source,
        sourceKey: key,
        request,
        routing: { ...routing },
        createdAt,
        expiresAt,
        resolve
      };
      const timeout = setTimeout(() => this.#timeout(id), Math.max(0, expiresAt - this.#now()));
      timeout.unref?.();
      record.timeout = timeout;
      this.#pending.set(id, record);
      this.#emit({ type: 'upsert', interaction: this.#view(record) });
    });
  }

  subscribe(listener: (event: InteractionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  listPending(): PendingInteraction[] {
    this.sweepExpired();
    return [...this.#pending.values()].map((record) => this.#view(record));
  }

  claim(
    id: string,
    presenterId: string,
    untrustedCapabilities: InteractionPresenterCapabilities
  ): { leaseToken: string; interaction: PendingInteraction } {
    this.sweepExpired();
    const record = this.#get(id);
    this.#releaseExpiredLease(record);

    if (record.routing.preferredPresenterId && record.routing.preferredPresenterId !== presenterId) {
      throw new HostInteractionError('presenter_not_preferred', 'Interaction is reserved for its preferred presenter');
    }
    const capabilities = interactionPresenterCapabilitiesSchema.parse(untrustedCapabilities);
    supportsRequest(record.request, record.routing, capabilities);
    if (record.lease) {
      throw new HostInteractionError('already_claimed', 'Interaction is already claimed');
    }

    const leaseToken = this.#createLeaseToken();
    record.lease = {
      presenterId,
      token: leaseToken,
      expiresAt: this.#now() + this.#leaseTtlMs
    };
    const interaction = this.#view(record);
    this.#emit({ type: 'upsert', interaction });
    return { leaseToken, interaction };
  }

  submit(id: string, leaseToken: string, values: Record<string, unknown>): void {
    const record = this.#getWithLease(id, leaseToken);
    this.#complete(record, { status: 'submitted', values });
  }

  renew(id: string, leaseToken: string): void {
    const record = this.#getWithLease(id, leaseToken);
    if (record.lease) record.lease.expiresAt = this.#now() + this.#leaseTtlMs;
  }

  cancel(id: string, leaseToken: string, reason: InteractionCancellationReason): void {
    const record = this.#getWithLease(id, leaseToken);
    this.#complete(record, { status: 'cancelled', reason });
  }

  releasePresenter(presenterId: string): void {
    for (const record of this.#pending.values()) {
      let changed = false;
      if (record.lease?.presenterId === presenterId) {
        record.lease = undefined;
        changed = true;
      }
      if (record.routing.preferredPresenterId === presenterId) {
        record.routing = { ...record.routing, preferredPresenterId: undefined };
        changed = true;
      }
      if (changed) this.#emit({ type: 'upsert', interaction: this.#view(record) });
    }
  }

  sweepExpired(): void {
    const now = this.#now();
    for (const record of [...this.#pending.values()]) {
      if (record.expiresAt <= now) {
        this.#complete(record, { status: 'cancelled', reason: 'timeout' });
      } else {
        if (this.#releaseExpiredLease(record)) {
          this.#emit({ type: 'upsert', interaction: this.#view(record) });
        }
      }
    }
  }

  #get(id: string): PendingRecord {
    const record = this.#pending.get(id);
    if (!record) throw new HostInteractionError('not_found', 'Interaction not found');
    return record;
  }

  #getWithLease(id: string, leaseToken: string): PendingRecord {
    const record = this.#get(id);
    this.#releaseExpiredLease(record);
    if (!record.lease || record.lease.token !== leaseToken) {
      throw new HostInteractionError('invalid_lease', 'Interaction lease is invalid');
    }
    return record;
  }

  #releaseExpiredLease(record: PendingRecord): boolean {
    if (!record.lease || record.lease.expiresAt > this.#now()) return false;
    record.lease = undefined;
    return true;
  }

  #view(record: PendingRecord): PendingInteraction {
    return projectPendingInteraction({
      id: record.id,
      source: record.source,
      request: record.request,
      mode: record.routing.mode,
      state: record.lease ? 'claimed' : 'pending',
      createdAt: new Date(record.createdAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString()
    });
  }

  #timeout(id: string): void {
    const record = this.#pending.get(id);
    if (record && record.expiresAt <= this.#now()) {
      this.#complete(record, { status: 'cancelled', reason: 'timeout' });
    }
  }

  #complete(record: PendingRecord, result: InteractionResult): void {
    this.#pending.delete(record.id);
    if (record.timeout) clearTimeout(record.timeout);
    this.#emit({
      type: 'removed',
      id: record.id,
      outcome: result.status === 'submitted' ? 'submitted' : result.reason === 'timeout' ? 'timeout' : 'cancelled'
    });
    record.resolve(result);
  }

  #emit(event: InteractionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
