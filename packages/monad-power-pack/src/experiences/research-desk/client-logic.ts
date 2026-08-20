import type {
  BlockCoverage,
  ClaimDecision,
  CrossRead,
  EvidenceClaim,
  EvidenceStatus,
  Report,
  ReportBlock,
  ResearchAssignment,
  ResearchNote,
  SourceManifestEntry,
  SourceRef,
  SourceStatus,
  SourceVisibility,
  Transformation,
  TransformationRun,
  TransformationSpend,
  VisibilityCell
} from './domain/index.ts';

import { z } from 'zod';

import {
  normalizeCrossRead,
  normalizeEvidenceClaim,
  normalizeNote,
  normalizeReport,
  normalizeResearchAssignment,
  normalizeSourceRef,
  normalizeTransformation,
  normalizeTransformationRun,
  normalizeVisibility,
  reportCoverage
} from './domain/index.ts';

export type FocusedPane = 'sources' | 'evidence' | 'report';
export type StatusTone = 'muted' | 'warning' | 'destructive' | 'success';

export interface ResearchViewModel {
  claimsById: ReadonlyMap<string, EvidenceClaim>;
  coverage: BlockCoverage[];
  linkedSourceIds: ReadonlySet<string>;
  linkedReportBlockIds: ReadonlySet<string>;
  selectedClaim: EvidenceClaim | null;
}

export interface PublishConflict {
  blockedBlocks: BlockCoverage[];
}

export interface PublishResult {
  published: boolean;
  report: Report;
  manifest: SourceManifestEntry[];
}

export interface ResearchMemberSummary {
  memberId: string;
  displayName: string;
  role: 'researcher' | 'evidence-engineer' | 'other';
  sessionId: string | null;
}

export interface ResearchOverview {
  projectId: string;
  report: {
    id: string;
    title: string;
    question: string;
    doneWhen: string | null;
    state: Report['state'];
    revision: number;
  } | null;
  stage: 'collecting' | 'verifying' | 'synthesizing' | 'review' | 'published';
  members: ResearchMemberSummary[];
  usage: { tokens: number | null; cost: { amount: number; currency: string } | null };
  counts: { sources: number; claims: number; needsYou: number };
}

const blockCoverageSchema = z.object({
  blockId: z.string(),
  heading: z.string(),
  kind: z.enum(['factual', 'analysis', 'limitation', 'method']),
  accepted: z.number().int().nonnegative(),
  contested: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative()
});

const overviewSchema = z.object({
  projectId: z.string(),
  report: z
    .object({
      id: z.string(),
      title: z.string(),
      question: z.string(),
      doneWhen: z.string().nullable(),
      state: z.enum(['draft', 'review', 'published']),
      revision: z.number().int().positive()
    })
    .nullable(),
  stage: z.enum(['collecting', 'verifying', 'synthesizing', 'review', 'published']),
  members: z.array(
    z.object({
      memberId: z.string(),
      role: z.enum(['researcher', 'evidence-engineer', 'other']),
      displayName: z.string(),
      sessionId: z.string().nullable()
    })
  ),
  usage: z.object({
    tokens: z.number().int().nonnegative().nullable(),
    cost: z.object({ amount: z.number(), currency: z.string() }).nullable()
  }),
  counts: z.object({
    sources: z.number().int().nonnegative(),
    claims: z.number().int().nonnegative(),
    needsYou: z.number().int().nonnegative()
  })
});

const transformationSpendSchema = z
  .object({
    transformationId: z.string(),
    label: z.string(),
    tier: z.enum(['fast', 'smart', 'power']),
    runs: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative().nullable(),
    cost: z.object({ amount: z.number(), currency: z.string() }).strict().nullable()
  })
  .strict();

const visibilityCellSchema = z.object({ memberId: z.string(), sourceId: z.string(), canRead: z.boolean() }).strict();

const visibilityScope = 'Controls which sources Research Desk sends to each member. It is not network isolation.';

export function parseOverviewPayload(payload: unknown): ResearchOverview {
  return overviewSchema.parse(named(payload, 'overview'));
}

export function parseSourcesPayload(payload: unknown): SourceRef[] {
  return z.array(z.unknown()).parse(named(payload, 'sources')).map(normalizeSourceRef);
}

export function parseEvidencePayload(payload: unknown): EvidenceClaim[] {
  return z.array(z.unknown()).parse(named(payload, 'evidence')).map(normalizeEvidenceClaim);
}

export function parseAssignmentsPayload(payload: unknown): ResearchAssignment[] {
  return z.array(z.unknown()).parse(named(payload, 'assignments')).map(normalizeResearchAssignment);
}

export function parseReportPayload(payload: unknown): { report: Report | null; coverage: BlockCoverage[] } {
  const object = z.object({ report: z.unknown().nullable(), coverage: z.array(blockCoverageSchema) }).parse(payload);
  return { report: object.report === null ? null : normalizeReport(object.report), coverage: object.coverage };
}

export function parseSourceMutation(payload: unknown): SourceRef {
  return normalizeSourceRef(named(payload, 'source'));
}

export function parseEvidenceMutation(payload: unknown): EvidenceClaim {
  return normalizeEvidenceClaim(named(payload, 'evidence'));
}

export function parseAssignmentMutation(payload: unknown): ResearchAssignment {
  return normalizeResearchAssignment(named(payload, 'assignment'));
}

export function parseCoverage(payload: unknown): BlockCoverage[] {
  return z.array(blockCoverageSchema).parse(named(payload, 'coverage'));
}

export function parseReportMutation(payload: unknown): Report {
  return normalizeReport(named(payload, 'report'));
}

export function parsePublishResult(payload: unknown): PublishResult {
  const object = z
    .object({
      published: z.boolean(),
      report: z.unknown(),
      manifest: z.array(
        z.object({
          sourceId: z.string(),
          title: z.string(),
          locator: z.string(),
          capturedAt: z.string().nullable(),
          fingerprint: z.string().nullable(),
          status: z.string()
        })
      )
    })
    .parse(payload);
  return { published: object.published, report: normalizeReport(object.report), manifest: object.manifest };
}

export function parseTransformationsPayload(payload: unknown): {
  transformations: Transformation[];
  runs: TransformationRun[];
  spend: TransformationSpend[];
} {
  const object = z
    .object({
      transformations: z.array(z.unknown()),
      runs: z.array(z.unknown()),
      spend: z.array(transformationSpendSchema)
    })
    .strict()
    .parse(payload);
  return {
    transformations: object.transformations.map(normalizeTransformation),
    runs: object.runs.map(normalizeTransformationRun),
    spend: object.spend
  };
}

export function parseTransformationMutation(payload: unknown): {
  run: TransformationRun;
  transformation: Transformation;
} {
  const object = z.object({ run: z.unknown(), transformation: z.unknown() }).strict().parse(payload);
  return {
    run: normalizeTransformationRun(object.run),
    transformation: normalizeTransformation(object.transformation)
  };
}

export function parseCrossReadsPayload(payload: unknown): CrossRead[] {
  return z.array(z.unknown()).parse(named(payload, 'crossReads')).map(normalizeCrossRead);
}

export function parseCrossReadMutation(payload: unknown): CrossRead {
  return normalizeCrossRead(named(payload, 'crossRead'));
}

export function parseCrossReadRuleMutation(payload: unknown): {
  crossRead: CrossRead;
  evidence: EvidenceClaim;
} {
  const object = z.object({ crossRead: z.unknown(), evidence: z.unknown() }).strict().parse(payload);
  return {
    crossRead: normalizeCrossRead(object.crossRead),
    evidence: normalizeEvidenceClaim(object.evidence)
  };
}

export function parseNotesPayload(payload: unknown): ResearchNote[] {
  return z.array(z.unknown()).parse(named(payload, 'notes')).map(normalizeNote);
}

export function parseNoteMutation(payload: unknown): ResearchNote {
  return normalizeNote(named(payload, 'note'));
}

export function parseNotePromotion(payload: unknown): { note: ResearchNote; evidence: EvidenceClaim } {
  const object = z.object({ note: z.unknown(), evidence: z.unknown() }).strict().parse(payload);
  return { note: normalizeNote(object.note), evidence: normalizeEvidenceClaim(object.evidence) };
}

export function parseNoteDeletion(payload: unknown): { deleted: true; noteId: string } {
  return z
    .object({ deleted: z.literal(true), noteId: z.string() })
    .strict()
    .parse(payload);
}

export function parseVisibilityPayload(payload: unknown): {
  visibility: SourceVisibility;
  matrix: VisibilityCell[];
  scope: typeof visibilityScope;
} {
  const object = z
    .object({
      visibility: z.unknown(),
      matrix: z.array(visibilityCellSchema),
      scope: z.literal(visibilityScope)
    })
    .strict()
    .parse(payload);
  return { visibility: normalizeVisibility(object.visibility), matrix: object.matrix, scope: object.scope };
}

export function parseVisibilityMutation(payload: unknown): {
  visibility: SourceVisibility;
  matrix: VisibilityCell[];
} {
  const object = z
    .object({ visibility: z.unknown(), matrix: z.array(visibilityCellSchema) })
    .strict()
    .parse(payload);
  return { visibility: normalizeVisibility(object.visibility), matrix: object.matrix };
}

export function researchViewModel(
  evidence: readonly EvidenceClaim[],
  report: Report | null,
  selectedEvidenceId: string | null
): ResearchViewModel {
  const claimsById = new Map(evidence.map((claim) => [claim.id, claim]));
  const selectedClaim = selectedEvidenceId ? (claimsById.get(selectedEvidenceId) ?? null) : null;
  return {
    claimsById,
    coverage: report ? reportCoverage(report, claimsById) : [],
    linkedSourceIds: new Set(selectedClaim?.citations.map((citation) => citation.sourceId) ?? []),
    linkedReportBlockIds: new Set(
      report?.blocks.filter((block) => block.evidenceIds.includes(selectedEvidenceId ?? '')).map((block) => block.id) ??
        []
    ),
    selectedClaim
  };
}

export function replaceClaim(evidence: readonly EvidenceClaim[], updated: EvidenceClaim): EvidenceClaim[] {
  const index = evidence.findIndex((claim) => claim.id === updated.id);
  if (index === -1) return [...evidence, updated];
  return evidence.with(index, updated);
}

export function replaceAssignment(
  assignments: readonly ResearchAssignment[],
  updated: ResearchAssignment
): ResearchAssignment[] {
  const index = assignments.findIndex((assignment) => assignment.id === updated.id);
  if (index === -1) return [...assignments, updated];
  return assignments.with(index, updated);
}

export function assignmentIsActive(assignment: ResearchAssignment): boolean {
  return assignment.state === 'queued' || assignment.state === 'running' || assignment.state === 'blocked';
}

export function assignmentTargetsClaim(assignments: readonly ResearchAssignment[], claimId: string): boolean {
  return assignments.some((assignment) => assignment.targetClaimId === claimId && assignmentIsActive(assignment));
}

export function assignmentTargetsBlock(assignments: readonly ResearchAssignment[], blockId: string): boolean {
  return assignments.some((assignment) => assignment.targetBlockId === blockId && assignmentIsActive(assignment));
}

export function decisionBody(
  status: ClaimDecision['status'],
  reason: string,
  editedText: string,
  originalText: string
): ClaimDecision {
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error('Add a reason for this decision.');
  const normalizedText = editedText.trim();
  if (status === 'accepted' && !normalizedText) throw new Error('The accepted claim cannot be empty.');
  return {
    status,
    reason: normalizedReason,
    ...(status === 'accepted' && normalizedText !== originalText ? { editedText: normalizedText } : {})
  };
}

export function sourceStatusTone(status: SourceStatus): StatusTone {
  if (status === 'blocked' || status === 'failed') return 'destructive';
  if (status === 'changed' || status === 'unreachable') return 'warning';
  if (status === 'available') return 'success';
  return 'muted';
}

export function evidenceStatusTone(status: EvidenceStatus): StatusTone {
  if (status === 'contested' || status === 'rejected') return 'destructive';
  if (status === 'accepted' || status === 'supported') return 'success';
  return 'muted';
}

export function sourceStatusDetail(source: SourceRef): string {
  const details: string[] = [];
  if (source.statusReason) details.push(source.statusReason);
  if (source.status === 'changed' || source.status === 'unreachable') details.push('snapshot kept');
  if (source.recheckedAt) details.push(`rechecked ${shortTime(source.recheckedAt)}`);
  if (source.capturedAt && source.status !== 'changed' && source.status !== 'unreachable') {
    details.push(`captured ${shortTime(source.capturedAt)}`);
  }
  if (source.fingerprint) details.push(`fp ${shortFingerprint(source.fingerprint)}`);
  return details.join(' · ');
}

export function coverageByBlock(coverage: readonly BlockCoverage[]): ReadonlyMap<string, BlockCoverage> {
  return new Map(coverage.map((item) => [item.blockId, item]));
}

export function reportBlockIsBlocked(block: ReportBlock, coverage: BlockCoverage | undefined): boolean {
  return block.kind === 'factual' && (coverage?.missing ?? 0) > 0;
}

export function crossReadCanBeRuled(crossRead: CrossRead): boolean {
  return (
    crossRead.readings.every((reading) => reading.state !== 'pending') &&
    crossRead.readings.filter((reading) => reading.state === 'answered').length >= 2
  );
}

export function visibleSourceIds(
  visibility: SourceVisibility,
  memberId: string,
  sources: readonly SourceRef[]
): string[] {
  const sourceIds = sources.map((source) => source.id);
  const rule = visibility.rules.find((candidate) => candidate.memberId === memberId);
  return rule?.sourceIds ? rule.sourceIds.filter((sourceId) => sourceIds.includes(sourceId)) : sourceIds;
}

export function toggledVisibilityRule(
  visibility: SourceVisibility,
  memberId: string,
  sources: readonly SourceRef[],
  sourceId: string,
  canRead: boolean
): string[] | null {
  const current = visibleSourceIds(visibility, memberId, sources);
  const next = canRead ? [...new Set([...current, sourceId])] : current.filter((candidate) => candidate !== sourceId);
  return next.length === sources.length ? null : next;
}

export function publishConflict(payload: unknown): PublishConflict | null {
  const parsed = z.object({ blockedBlocks: z.array(blockCoverageSchema) }).safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function firstBlockedBlock(conflict: PublishConflict | null): string | null {
  return conflict?.blockedBlocks[0]?.blockId ?? null;
}

export function shortFingerprint(fingerprint: string): string {
  if (fingerprint.length <= 12) return fingerprint;
  return `${fingerprint.slice(0, 6)}…${fingerprint.slice(-4)}`;
}

function shortTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function named(payload: unknown, key: string): unknown {
  return z.record(z.string(), z.unknown()).parse(payload)[key];
}
