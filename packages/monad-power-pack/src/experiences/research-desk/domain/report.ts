import type { EvidenceClaim } from './evidence.ts';

import { z } from 'zod';

import { definedOnly } from './defaults.ts';
import { isCitableInReport } from './evidence.ts';

export const REPORT_BLOCK_KINDS = ['factual', 'analysis', 'limitation', 'method'] as const;
export const REPORT_STATES = ['draft', 'review', 'published'] as const;

const reportBlockKindSchema = z.enum(REPORT_BLOCK_KINDS);
const reportStateSchema = z.enum(REPORT_STATES);

export type ReportBlockKind = z.infer<typeof reportBlockKindSchema>;
export type ReportState = z.infer<typeof reportStateSchema>;

const reportBlockSchema = z.object({
  id: z.string().min(1),
  kind: reportBlockKindSchema,
  heading: z.string().min(1),
  markdown: z.string(),
  evidenceIds: z.array(z.string().min(1)),
  kindChangedByHuman: z.boolean()
});

const reportSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  doneWhen: z.string().min(1).nullable(),
  state: reportStateSchema,
  revision: z.number().int().positive(),
  blocks: z.array(reportBlockSchema),
  sessionId: z.string().min(1),
  publishedAt: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type ReportBlock = z.infer<typeof reportBlockSchema>;
export type Report = z.infer<typeof reportSchema>;

export function makeReport(
  input: Pick<Report, 'id' | 'projectId' | 'title' | 'question' | 'sessionId'> &
    Partial<Omit<Report, 'schemaVersion' | 'id' | 'projectId' | 'title' | 'question' | 'sessionId'>>
): Report {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return reportSchema.parse({
    schemaVersion: 1,
    doneWhen: null,
    state: 'draft',
    revision: 1,
    blocks: [],
    publishedAt: null,
    version: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    ...definedOnly(input)
  });
}

export function normalizeReport(value: unknown): Report {
  return reportSchema.parse(value);
}

function assertVersion(report: Report, expectedVersion: number): void {
  if (report.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${report.version}`);
  }
}

function assertDraft(report: Report): void {
  if (report.state === 'published') {
    throw new Error('a published revision is immutable; start the next revision instead');
  }
}

export interface BlockCoverage {
  blockId: string;
  heading: string;
  kind: ReportBlockKind;
  accepted: number;
  contested: number;
  /** Unmet evidence requirements, not a count of citations. A factual block needs at least one
   *  accepted claim, so this is 1 while it has none and 0 once it does — which is what the reader of
   *  "0 accepted / 1 contested / 1 missing" is being told: the requirement is still open. */
  missing: number;
}

export function coverageFor(block: ReportBlock, claims: ReadonlyMap<string, EvidenceClaim>): BlockCoverage {
  const cited = block.evidenceIds.map((id) => claims.get(id));
  const accepted = cited.filter((claim) => claim && isCitableInReport(claim)).length;
  const contested = cited.filter((claim) => claim?.status === 'contested').length;
  const requiresEvidence = block.kind === 'factual';
  return {
    blockId: block.id,
    heading: block.heading,
    kind: block.kind,
    accepted,
    contested,
    missing: requiresEvidence && accepted === 0 ? 1 : 0
  };
}

export function reportCoverage(report: Report, claims: ReadonlyMap<string, EvidenceClaim>): BlockCoverage[] {
  return report.blocks.map((block) => coverageFor(block, claims));
}

/** Blocks standing between this draft and a publish. Only `factual` blocks are checked: requiring a
 *  citation on analysis, limitation, and method text would just manufacture decorative references,
 *  which is the failure this gate exists to prevent. */
export function publishBlockers(report: Report, claims: ReadonlyMap<string, EvidenceClaim>): BlockCoverage[] {
  return reportCoverage(report, claims).filter((coverage) => coverage.missing > 0);
}

export function upsertBlock(report: Report, expectedVersion: number, block: ReportBlock, now: string): Report {
  assertVersion(report, expectedVersion);
  assertDraft(report);
  const parsed = reportBlockSchema.parse(block);
  const index = report.blocks.findIndex((existing) => existing.id === parsed.id);
  const blocks = index === -1 ? [...report.blocks, parsed] : report.blocks.with(index, parsed);
  return { ...report, blocks, version: report.version + 1, updatedAt: now };
}

export interface BlockPatch {
  kind?: ReportBlockKind;
  heading?: string;
  markdown?: string;
  evidenceIds?: string[];
}

/** Retyping a factual block as analysis is the only way past the publish gate, so it is recorded as a
 *  human act on the block rather than silently applied — an operator reviewing the report can see
 *  which blocks were reclassified and a spike in reclassification is measurable. */
export function patchBlock(
  report: Report,
  expectedVersion: number,
  blockId: string,
  patch: BlockPatch,
  actor: 'human' | 'agent',
  now: string
): Report {
  assertVersion(report, expectedVersion);
  assertDraft(report);
  const index = report.blocks.findIndex((block) => block.id === blockId);
  if (index === -1) throw new Error(`report block not found: ${blockId}`);
  const current = report.blocks[index];
  if (!current) throw new Error(`report block not found: ${blockId}`);
  const kindChanged = patch.kind !== undefined && patch.kind !== current.kind;
  if (kindChanged && actor !== 'human') throw new Error('only a human changes a report block kind');
  const next = reportBlockSchema.parse({
    ...current,
    ...patch,
    kindChangedByHuman: current.kindChangedByHuman || kindChanged
  });
  return { ...report, blocks: report.blocks.with(index, next), version: report.version + 1, updatedAt: now };
}

export function removeBlock(report: Report, expectedVersion: number, blockId: string, now: string): Report {
  assertVersion(report, expectedVersion);
  assertDraft(report);
  const blocks = report.blocks.filter((block) => block.id !== blockId);
  if (blocks.length === report.blocks.length) throw new Error(`report block not found: ${blockId}`);
  return { ...report, blocks, version: report.version + 1, updatedAt: now };
}

export class PublishBlockedError extends Error {
  readonly blockers: BlockCoverage[];

  constructor(blockers: BlockCoverage[]) {
    super(`cannot publish: ${blockers.length} factual blocks have no accepted evidence`);
    this.name = 'PublishBlockedError';
    this.blockers = blockers;
  }
}

export function publishReport(
  report: Report,
  expectedVersion: number,
  claims: ReadonlyMap<string, EvidenceClaim>,
  now: string
): Report {
  assertVersion(report, expectedVersion);
  assertDraft(report);
  const blockers = publishBlockers(report, claims);
  if (blockers.length > 0) throw new PublishBlockedError(blockers);
  return { ...report, state: 'published', publishedAt: now, version: report.version + 1, updatedAt: now };
}

/** The next revision is a new draft; the published one it came from is never edited again, so a reader
 *  holding an exported report can always be shown the exact text that was approved. */
export function startNextRevision(report: Report, id: string, now: string): Report {
  if (report.state !== 'published') throw new Error('only a published revision starts the next one');
  return makeReport({
    ...report,
    id,
    state: 'draft',
    revision: report.revision + 1,
    publishedAt: null,
    version: 0,
    createdAt: now,
    updatedAt: now
  });
}

export interface SourceManifestEntry {
  sourceId: string;
  title: string;
  locator: string;
  capturedAt: string | null;
  fingerprint: string | null;
  status: string;
}

export function manifestEntries(
  report: Report,
  claims: ReadonlyMap<string, EvidenceClaim>,
  sources: ReadonlyMap<
    string,
    {
      id: string;
      title: string;
      locator: string;
      capturedAt: string | null;
      fingerprint: string | null;
      status: string;
    }
  >
): SourceManifestEntry[] {
  const cited = new Set<string>();
  for (const block of report.blocks) {
    for (const evidenceId of block.evidenceIds) {
      for (const citation of claims.get(evidenceId)?.citations ?? []) cited.add(citation.sourceId);
    }
  }
  return [...cited]
    .map((sourceId) => sources.get(sourceId))
    .filter((source) => source !== undefined)
    .map((source) => ({
      sourceId: source.id,
      title: source.title,
      locator: source.locator,
      capturedAt: source.capturedAt,
      fingerprint: source.fingerprint,
      status: source.status
    }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}
