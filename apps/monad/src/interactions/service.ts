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
import safeRegex from 'safe-regex2';

import { projectPendingInteraction } from './redact';

export type InteractionRouting = {
  mode: 'foreground' | 'background';
  preferredPresenterId?: string;
};

export type InteractionCancellationReason = Extract<InteractionResult, { status: 'cancelled' }>['reason'];
const MAX_PATTERN_INPUT_LENGTH = 4_096;

export type HostInteractionErrorCode =
  | 'not_found'
  | 'source_limit'
  | 'presenter_not_preferred'
  | 'incompatible_presenter'
  | 'already_claimed'
  | 'invalid_lease'
  | 'invalid_submission'
  | 'unsafe_pattern';

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

function isNarrowlySafePattern(pattern: string): boolean {
  if (!safeRegex(pattern)) return false;
  let escaped = false;
  let inCharacterClass = false;
  let variableQuantifiers = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '[') {
      inCharacterClass = true;
      continue;
    }
    if (character === ']' && inCharacterClass) {
      inCharacterClass = false;
      continue;
    }
    if (inCharacterClass) continue;
    if (character === '(' || character === ')' || character === '|') return false;
    if (character === '*' || character === '+' || character === '?') variableQuantifiers += 1;
    if (character === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end === -1) return false;
      const range = pattern.slice(index + 1, end);
      if (!/^\d+(?:,\d*)?$/.test(range)) return false;
      if (range.includes(',')) variableQuantifiers += 1;
      index = end;
    }
    if (variableQuantifiers > 1) return false;
  }
  return !escaped && !inCharacterClass;
}

function validateRequestPatterns(request: InteractionRequest): void {
  if (request.type !== 'form') return;
  for (const field of request.fields) {
    if (field.type === 'string' && field.pattern && !isNarrowlySafePattern(field.pattern)) {
      throw new HostInteractionError(
        'unsafe_pattern',
        `Interaction field "${field.id}" uses an unsafe validation pattern`
      );
    }
  }
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

function invalidSubmission(message: string): never {
  throw new HostInteractionError('invalid_submission', message);
}

function validateSubmission(request: InteractionRequest, values: Record<string, unknown>): Record<string, unknown> {
  if (request.type === 'confirm') {
    if (values.confirmed !== true) invalidSubmission('Confirmation must be explicitly accepted');
    if (Object.keys(values).some((key) => key !== 'confirmed')) {
      invalidSubmission('Confirmation contains undeclared values');
    }
    return { confirmed: true };
  }

  if (request.type === 'select') {
    if (typeof values.value !== 'string' || !request.options.some((option) => option.value === values.value)) {
      invalidSubmission('Selection must be one of the declared options');
    }
    if (Object.keys(values).some((key) => key !== 'value')) invalidSubmission('Selection contains undeclared values');
    return { value: values.value };
  }

  const fields = new Map(request.fields.map((field) => [field.id, field]));
  const validated: Record<string, unknown> = {};
  for (const field of request.fields) {
    const present = Object.hasOwn(values, field.id);
    const value = values[field.id];
    const missing = !present || value === undefined || value === null || value === '';
    if (field.required && missing) invalidSubmission(`Interaction field "${field.id}" is required`);
    if (!present || value === undefined || value === null) continue;

    switch (field.type) {
      case 'string':
      case 'secret':
        if (typeof value !== 'string') invalidSubmission(`Interaction field "${field.id}" must be a string`);
        if (field.type === 'string' && field.pattern) {
          if (value.length > MAX_PATTERN_INPUT_LENGTH) {
            invalidSubmission(`Interaction field "${field.id}" is too long for pattern validation`);
          }
          let pattern: RegExp;
          try {
            pattern = new RegExp(field.pattern);
          } catch {
            invalidSubmission(`Interaction field "${field.id}" has an invalid pattern`);
          }
          if (!pattern.test(value)) invalidSubmission(`Interaction field "${field.id}" has an invalid format`);
        }
        break;
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          invalidSubmission(`Interaction field "${field.id}" must be a finite number`);
        }
        if (field.min !== undefined && value < field.min) {
          invalidSubmission(`Interaction field "${field.id}" must be at least ${field.min}`);
        }
        if (field.max !== undefined && value > field.max) {
          invalidSubmission(`Interaction field "${field.id}" must be at most ${field.max}`);
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') invalidSubmission(`Interaction field "${field.id}" must be a boolean`);
        break;
      case 'select':
        if (typeof value !== 'string' || !field.options.some((option) => option.value === value)) {
          invalidSubmission(`Interaction field "${field.id}" must be one of the declared options`);
        }
        break;
    }
    validated[field.id] = value;
  }

  for (const key of Object.keys(values)) {
    if (!fields.has(key)) invalidSubmission(`Interaction field "${key}" is not declared`);
  }
  return validated;
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
    validateRequestPatterns(request);
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
    this.#complete(record, { status: 'submitted', values: validateSubmission(record.request, values) });
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
