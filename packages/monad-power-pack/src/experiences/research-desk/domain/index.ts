export type {
  ResearchAssignment,
  ResearchAssignmentRole,
  ResearchAssignmentState,
  ResearchContextReceipt
} from './assignment.ts';
export type { CrossRead, CrossReading, CrossReadVerdict } from './crossread.ts';
export type {
  Citation,
  CitationStance,
  ClaimDecision,
  EvidenceClaim,
  EvidenceContribution,
  EvidenceDerivation,
  EvidenceStatus
} from './evidence.ts';
export type { ResearchNote } from './note.ts';
export type {
  BlockCoverage,
  BlockPatch,
  Report,
  ReportBlock,
  ReportBlockKind,
  ReportState,
  SourceManifestEntry
} from './report.ts';
export type { SourceKind, SourceRef, SourceStatus, SourceType } from './source.ts';
export type {
  Transformation,
  TransformationOutput,
  TransformationRole,
  TransformationRun,
  TransformationSpend,
  TransformationTier
} from './transformation.ts';
export type { SourceVisibility, VisibilityCell, VisibilityRule } from './visibility.ts';

export {
  makeResearchAssignment,
  normalizeResearchAssignment,
  RESEARCH_ASSIGNMENT_ROLES,
  RESEARCH_ASSIGNMENT_STATES,
  researchAssignmentSchema,
  researchContextReceiptSchema,
  transitionResearchAssignment
} from './assignment.ts';
export {
  answeredReadings,
  claimFromCrossRead,
  failReading,
  isComplete,
  makeCrossRead,
  markClaimProduced,
  normalizeCrossRead,
  recordReading,
  ruleOnCrossRead
} from './crossread.ts';
export {
  addCitation,
  applyEvidenceContribution,
  attachDerivation,
  CITATION_STANCES,
  decideClaim,
  EVIDENCE_STATUSES,
  evidenceContributionSchema,
  isCitableInReport,
  makeEvidenceClaim,
  makeEvidenceContribution,
  normalizeEvidenceClaim,
  reopenClaim,
  statusFromCitations
} from './evidence.ts';
export { editNote, makeNote, markNotePromoted, normalizeNote } from './note.ts';
export {
  coverageFor,
  makeReport,
  manifestEntries,
  normalizeReport,
  PublishBlockedError,
  patchBlock,
  publishBlockers,
  publishReport,
  REPORT_BLOCK_KINDS,
  REPORT_STATES,
  removeBlock,
  reportCoverage,
  startNextRevision,
  upsertBlock
} from './report.ts';
export {
  archiveSource,
  blockSource,
  captureSource,
  isCitable,
  makeSourceRef,
  markSourceRot,
  normalizeSourceRef,
  SOURCE_KINDS,
  SOURCE_STATUSES,
  SOURCE_TYPES
} from './source.ts';
export {
  BUILT_IN_TRANSFORMATIONS,
  failRun,
  makeTransformation,
  makeTransformationRun,
  normalizeTransformation,
  normalizeTransformationRun,
  settleRun,
  spendByTransformation,
  TRANSFORMATION_OUTPUTS,
  TRANSFORMATION_ROLES,
  TRANSFORMATION_TIERS
} from './transformation.ts';
export {
  canRead,
  makeVisibility,
  normalizeVisibility,
  readableSources,
  setRule,
  visibilityMatrix
} from './visibility.ts';
