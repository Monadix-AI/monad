import { z } from 'zod';

import { definedOnly } from './defaults.ts';

export const SOURCE_KINDS = ['url', 'file', 'project-artifact'] as const;
export const SOURCE_TYPES = ['primary', 'secondary', 'supplied'] as const;
export const SOURCE_STATUSES = [
  'queued',
  'available',
  'blocked',
  'failed',
  'changed',
  'unreachable',
  'archived'
] as const;

const sourceKindSchema = z.enum(SOURCE_KINDS);
const sourceTypeSchema = z.enum(SOURCE_TYPES);
const sourceStatusSchema = z.enum(SOURCE_STATUSES);

export type SourceKind = z.infer<typeof sourceKindSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type SourceStatus = z.infer<typeof sourceStatusSchema>;

const sourceRefSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  kind: sourceKindSchema,
  type: sourceTypeSchema,
  title: z.string().min(1),
  locator: z.string().min(1),
  status: sourceStatusSchema,
  statusReason: z.string().min(1).nullable(),
  fingerprint: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  messageId: z.string().min(1).nullable(),
  artifactPath: z.string().min(1).nullable(),
  capturedAt: z.string().min(1).nullable(),
  capturedByMemberId: z.string().min(1),
  recheckedAt: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type SourceRef = z.infer<typeof sourceRefSchema>;

export function makeSourceRef(
  input: Pick<SourceRef, 'id' | 'projectId' | 'kind' | 'title' | 'locator' | 'sessionId' | 'capturedByMemberId'> &
    Partial<Omit<SourceRef, 'schemaVersion' | 'id' | 'projectId' | 'kind' | 'title' | 'locator'>>
): SourceRef {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return sourceRefSchema.parse({
    schemaVersion: 1,
    type: 'secondary',
    status: 'queued',
    statusReason: null,
    fingerprint: null,
    messageId: null,
    artifactPath: null,
    capturedAt: null,
    recheckedAt: null,
    version: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    ...definedOnly(input)
  });
}

export function normalizeSourceRef(value: unknown): SourceRef {
  return sourceRefSchema.parse(value);
}

function assertVersion(source: SourceRef, expectedVersion: number): void {
  if (source.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${source.version}`);
  }
}

/** Record a completed capture. The fingerprint written here is what every later citation is anchored
 *  to; `markSourceRot` deliberately cannot replace it. */
export function captureSource(
  source: SourceRef,
  expectedVersion: number,
  input: { fingerprint: string; type?: SourceType; artifactPath?: string; messageId?: string },
  now: string
): SourceRef {
  assertVersion(source, expectedVersion);
  return {
    ...source,
    status: 'available',
    statusReason: null,
    type: input.type ?? source.type,
    fingerprint: input.fingerprint,
    artifactPath: input.artifactPath ?? source.artifactPath,
    messageId: input.messageId ?? source.messageId,
    capturedAt: now,
    version: source.version + 1,
    updatedAt: now
  };
}

/** A source the agent could not read. Kept visible as part of the research record — not an error to
 *  be retried away — so the reason is required. */
export function blockSource(
  source: SourceRef,
  expectedVersion: number,
  status: Extract<SourceStatus, 'blocked' | 'failed'>,
  reason: string,
  now: string
): SourceRef {
  assertVersion(source, expectedVersion);
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('a blocked source requires a reason');
  return { ...source, status, statusReason: trimmed, version: source.version + 1, updatedAt: now };
}

/** Recheck outcome from the worker. Only the status, its reason, and the recheck time move: the
 *  captured snapshot and its fingerprint stay exactly as cited, so a later upstream edit can never
 *  silently rewrite what a published claim was based on. */
export function markSourceRot(
  source: SourceRef,
  expectedVersion: number,
  status: Extract<SourceStatus, 'changed' | 'unreachable'>,
  reason: string,
  now: string
): SourceRef {
  assertVersion(source, expectedVersion);
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('a rechecked source requires a reason');
  if (source.status === 'archived') throw new Error('an archived source is not rechecked');
  return {
    ...source,
    status,
    statusReason: trimmed,
    recheckedAt: now,
    version: source.version + 1,
    updatedAt: now
  };
}

export function archiveSource(source: SourceRef, expectedVersion: number, reason: string, now: string): SourceRef {
  assertVersion(source, expectedVersion);
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('archiving a source requires a reason');
  return { ...source, status: 'archived', statusReason: trimmed, version: source.version + 1, updatedAt: now };
}

/** A source whose captured snapshot can still back a citation. `changed`/`unreachable` qualify: the
 *  snapshot that was read is still on disk; only the upstream moved. */
export function isCitable(source: SourceRef): boolean {
  return source.status === 'available' || source.status === 'changed' || source.status === 'unreachable';
}
