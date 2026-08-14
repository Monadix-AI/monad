export type {
  Citation,
  CitationStance,
  ClaimDecision,
  EvidenceClaim,
  EvidenceDerivation,
  EvidenceStatus
} from './evidence.ts';
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

export {
  addCitation,
  attachDerivation,
  CITATION_STANCES,
  decideClaim,
  EVIDENCE_STATUSES,
  isCitableInReport,
  makeEvidenceClaim,
  normalizeEvidenceClaim,
  reopenClaim,
  statusFromCitations
} from './evidence.ts';
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
