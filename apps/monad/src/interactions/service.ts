import type { ClarifyAskRequest, ClarifyAskResult, RecoveredClarificationAnswer } from './clarify-policy';
import type {
  ActiveInteraction,
  ClarifyInteraction,
  InteractionCancellationReason,
  InteractionRouting,
  StructuredInteraction
} from './types';

import {
  type ClarifyRespondResponse,
  type InteractionEvent,
  type InteractionPresenterCapabilities,
  type InteractionProducer,
  type InteractionRequest,
  type InteractionResult,
  interactionPresenterCapabilitiesSchema,
  interactionProducerSchema,
  interactionRequestSchema,
  type PendingInteraction
} from '@monad/protocol';

import { ClarifyCapability, type ClarifyCapabilityOptions, type ClarifyHost } from './clarify-capability';
import { HostInteractionError } from './errors';
import { projectPendingInteraction } from './redact';
import { supportsRequest, validateRequestPatterns, validateSubmission } from './structured-validation';

export type { ClarifyCapabilityOptions } from './clarify-capability';
export type { ClarifyAskRequest, ClarifyAskResult, RecoveredClarificationAnswer } from './clarify-policy';
export type { InteractionCancellationReason, InteractionRouting } from './types';

export * from './errors';

export type InteractionServiceOptions = {
  now?: () => number;
  createId?: () => string;
  createLeaseToken?: () => string;
  defaultTimeoutMs?: number;
  leaseTtlMs?: number;
  maxPendingPerSource?: number;
  clarify?: ClarifyCapabilityOptions;
};

function defaultId(): string {
  return `interaction-${crypto.randomUUID()}`;
}

function defaultLeaseToken(): string {
  return crypto.randomUUID();
}

function sourceKey(source: InteractionProducer): string {
  return source.kind === 'builtin' ? `builtin:${source.id}` : `atom-pack:${source.packId}:${source.atomId}`;
}

export class InteractionService {
  readonly #pending = new Map<string, ActiveInteraction>();
  readonly #listeners = new Set<(event: InteractionEvent) => void>();
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #createLeaseToken: () => string;
  readonly #defaultTimeoutMs: number;
  readonly #leaseTtlMs: number;
  readonly #maxPendingPerSource: number;

  // Ids claimed by an in-flight clarify ask across its `await ingress.deliver` window, before the
  // record lands in `#pending`. Both kinds consult it so a concurrent ask, a colliding structured
  // `createId()`, or a restore cannot register the same id twice and orphan the first waiter.
  readonly #reservedIds = new Set<string>();
  // The clarify interaction kind. Its orchestration and sinks live in ClarifyCapability; the capability
  // owns NO active map — it drives this service's one `#pending` through the `#clarifyHost()` callbacks.
  #clarify?: ClarifyCapability;

  constructor(options: InteractionServiceOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? defaultId;
    this.#createLeaseToken = options.createLeaseToken ?? defaultLeaseToken;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.#leaseTtlMs = options.leaseTtlMs ?? 30_000;
    this.#maxPendingPerSource = options.maxPendingPerSource ?? 3;
    if (options.clarify) this.enableClarify(options.clarify);
  }

  /** Whether the clarify interaction kind has been wired onto this instance. */
  get clarifyEnabled(): boolean {
    return this.#clarify !== undefined;
  }

  /** Wire the clarify interaction kind onto this instance. Idempotency: enabling twice throws — the
   *  daemon has exactly one clarify sink, and a second enable would silently orphan the first. The
   *  capability is attached before restore runs so a fatal restore collision leaves an inspectable
   *  (fail-closed) state rather than a half-built service. */
  enableClarify(options: ClarifyCapabilityOptions): void {
    if (this.#clarify) throw new Error('clarify capability is already enabled on this interaction service');
    const capability = new ClarifyCapability(options, this.#clarifyHost());
    this.#clarify = capability;
    capability.restore(options.restore ?? []);
  }

  #clarifyHost(): ClarifyHost {
    return {
      now: () => this.#now(),
      getActive: (id) => this.#pending.get(id),
      isReserved: (id) => this.#reservedIds.has(id),
      reserveId: (id) => void this.#reservedIds.add(id),
      releaseId: (id) => void this.#reservedIds.delete(id),
      register: (record) => this.#register(record),
      getClarify: (id) => this.#pendingClarify(id),
      terminate: (record, result) => this.#terminate(record, result),
      countClarify: () => {
        let count = 0;
        for (const record of this.#pending.values()) if (record.kind === 'clarify') count += 1;
        return count;
      }
    };
  }

  async request(
    untrustedSource: InteractionProducer,
    untrustedRequest: InteractionRequest,
    routing: InteractionRouting = { mode: 'background' }
  ): Promise<InteractionResult> {
    const source = interactionProducerSchema.parse(untrustedSource);
    const request = interactionRequestSchema.parse(untrustedRequest);
    validateRequestPatterns(request);
    const key = sourceKey(source);
    const sourcePendingCount = [...this.#pending.values()].filter(
      (record) => record.kind === 'structured' && record.sourceKey === key
    ).length;
    if (sourcePendingCount >= this.#maxPendingPerSource) {
      throw new HostInteractionError(
        'source_limit',
        `Interaction source already has ${this.#maxPendingPerSource} pending requests`
      );
    }

    const id = this.#createId();
    if (this.#pending.has(id) || this.#reservedIds.has(id)) {
      throw new HostInteractionError('id_collision', `Interaction id ${id} is already in use`);
    }
    const createdAt = this.#now();
    const expiresAt = createdAt + (request.timeoutMs ?? this.#defaultTimeoutMs);

    return await new Promise<InteractionResult>((resolve) => {
      this.#register({
        kind: 'structured',
        id,
        source,
        sourceKey: key,
        request,
        routing: { ...routing },
        createdAt,
        expiresAt,
        resolve
      });
    });
  }

  // The single entry point that makes an interaction active: index it and arm its timer. Both kinds
  // enter the active set through here, so the register side of the lifecycle is owned in one place.
  // Returns the arm timestamp so the clarify ask can compute the request's `expiresAt` from it.
  #register(record: ActiveInteraction): number {
    if (this.#pending.has(record.id)) {
      throw new HostInteractionError('id_collision', `Interaction id ${record.id} is already active`);
    }
    const armedAt = this.#now();
    this.#pending.set(record.id, record);
    if (record.kind === 'structured') {
      const timeout = setTimeout(() => this.#timeout(record.id), Math.max(0, record.expiresAt - this.#now()));
      timeout.unref?.();
      record.timeout = timeout;
      this.#emit({ type: 'upsert', interaction: this.#view(record) });
    } else if (record.clarifyDelayMs !== undefined) {
      const timeout = setTimeout(() => {
        const current = this.#pending.get(record.id);
        if (current === record) this.#clarify?.onTimeout(record);
      }, record.clarifyDelayMs);
      record.timeout = timeout;
    }
    return armedAt;
  }

  subscribe(listener: (event: InteractionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  listPending(): PendingInteraction[] {
    this.sweepExpired();
    return [...this.#pending.values()]
      .filter((record): record is StructuredInteraction => record.kind === 'structured')
      .map((record) => this.#view(record));
  }

  claim(
    id: string,
    presenterId: string,
    untrustedCapabilities: InteractionPresenterCapabilities
  ): { leaseToken: string; interaction: PendingInteraction } {
    this.sweepExpired();
    const record = this.#getStructured(id);
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
    const record = this.#getStructuredWithLease(id, leaseToken);
    this.#terminate(record, { status: 'submitted', values: validateSubmission(record.request, values) });
  }

  renew(id: string, leaseToken: string): void {
    const record = this.#getStructuredWithLease(id, leaseToken);
    if (record.lease) record.lease.expiresAt = this.#now() + this.#leaseTtlMs;
  }

  cancel(id: string, leaseToken: string, reason: InteractionCancellationReason): void {
    const record = this.#getStructuredWithLease(id, leaseToken);
    this.#terminate(record, { status: 'cancelled', reason });
  }

  releasePresenter(presenterId: string): void {
    for (const record of this.#pending.values()) {
      if (record.kind !== 'structured') continue;
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
      if (record.kind !== 'structured') continue;
      if (record.expiresAt <= now) {
        this.#terminate(record, { status: 'cancelled', reason: 'timeout' });
      } else {
        if (this.#releaseExpiredLease(record)) {
          this.#emit({ type: 'upsert', interaction: this.#view(record) });
        }
      }
    }
  }

  #getStructured(id: string): StructuredInteraction {
    const record = this.#pending.get(id);
    if (record?.kind !== 'structured') throw new HostInteractionError('not_found', 'Interaction not found');
    return record;
  }

  #getStructuredWithLease(id: string, leaseToken: string): StructuredInteraction {
    const record = this.#getStructured(id);
    this.#releaseExpiredLease(record);
    if (!record.lease || record.lease.token !== leaseToken) {
      throw new HostInteractionError('invalid_lease', 'Interaction lease is invalid');
    }
    return record;
  }

  #releaseExpiredLease(record: StructuredInteraction): boolean {
    if (!record.lease || record.lease.expiresAt > this.#now()) return false;
    record.lease = undefined;
    return true;
  }

  #view(record: StructuredInteraction): PendingInteraction {
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
    if (record && record.kind === 'structured' && record.expiresAt <= this.#now()) {
      this.#terminate(record, { status: 'cancelled', reason: 'timeout' });
    }
  }

  // The single terminal transition: remove the active record, clear its timer, and fire its outcome.
  // Idempotent (a second call for an already-removed record is a no-op), so concurrent settle paths and
  // a fired timer racing a human answer converge safely.
  #terminate(record: ActiveInteraction, result: InteractionResult | ClarifyRespondResponse): void {
    if (this.#pending.get(record.id) !== record) return;
    if (record.kind === 'clarify') {
      const terminal = result as ClarifyRespondResponse;
      if (terminal.status === 'not-found') return;
      this.#pending.delete(record.id);
      if (record.timeout) clearTimeout(record.timeout);
      // Map removal + timer clear are the service's; the clarify outcome (terminal ledger, waiter
      // resolution, recovered continuation) belongs to the capability.
      this.#clarify?.onTerminated(record, terminal);
      return;
    }
    const structured = result as InteractionResult;
    this.#pending.delete(record.id);
    if (record.timeout) clearTimeout(record.timeout);
    this.#emit({
      type: 'removed',
      id: record.id,
      outcome:
        structured.status === 'submitted' ? 'submitted' : structured.reason === 'timeout' ? 'timeout' : 'cancelled'
    });
    record.resolve(structured);
  }

  #emit(event: InteractionEvent): void {
    for (const listener of this.#listeners) listener(event);
  }

  #pendingClarify(id: string): ClarifyInteraction | undefined {
    const record = this.#pending.get(id);
    return record?.kind === 'clarify' ? record : undefined;
  }

  // ── Clarify interaction kind (delegated to ClarifyCapability) ─────────────────────────────────
  // Durable agent→human questions. The orchestration lives in the capability; these are the public
  // facade the daemon calls. Each requires the capability be enabled first (fail-closed otherwise).

  readonly ask = async (sessionId: string, request: ClarifyAskRequest): Promise<ClarifyAskResult> =>
    this.#requireClarify().ask(sessionId, request);

  readonly askStructured = async (
    sessionId: string,
    request: ClarifyAskRequest,
    opts?: { signal?: AbortSignal }
  ): Promise<ClarifyAskResult> => this.#requireClarify().askStructured(sessionId, request, opts);

  async respond(requestId: string, answer?: string, action?: 'complete' | 'cancel'): Promise<ClarifyRespondResponse> {
    return this.#requireClarify().respond(requestId, answer, action);
  }

  get pendingCount(): number {
    return this.#clarify?.pendingCount ?? 0;
  }

  setRecoveredContinuation(callback: (answer: RecoveredClarificationAnswer) => Promise<void>): void {
    this.#requireClarify().setRecoveredContinuation(callback);
  }

  #requireClarify(): ClarifyCapability {
    if (!this.#clarify) throw new Error('clarify capability is not configured on this interaction service');
    return this.#clarify;
  }
}
