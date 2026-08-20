import type { WorkplaceExperienceApiContext } from '@monad/sdk-atom';
import type { EvidenceClaim, EvidenceContribution, Report, ResearchAssignment, SourceRef } from './domain/index.ts';

import { createHash } from 'node:crypto';

import {
  applyEvidenceContribution,
  normalizeEvidenceClaim,
  normalizeReport,
  normalizeResearchAssignment,
  normalizeSourceRef,
  patchBlock,
  transitionResearchAssignment
} from './domain/index.ts';

const SOURCE_PREFIX = 'source/';
const EVIDENCE_PREFIX = 'evidence/';
const REPORT_KEY = 'report/current';
const ASSIGNMENT_PREFIX = 'assignment/';
const CAS_RETRY_LIMIT = 5;

export function researchDeskId(prefix: string, projectId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update(`${projectId}\0${idempotencyKey}`).digest('hex');
  return `${prefix}_${digest.slice(0, 20)}`;
}

export interface StateEvent {
  type: string;
  [key: string]: unknown;
}

/** The record's version is the one that counts, so the projection is stamped with the version the
 *  state store is about to assign. A caller may build several domain transitions in memory before
 *  persisting (ingest does), and without this its in-flight version would drift from the record's and
 *  every later read would look corrupt. */
export async function swapRecord<T extends { version: number }>(
  context: WorkplaceExperienceApiContext,
  projectId: string,
  key: string,
  expectedVersion: number | null,
  value: T,
  event: StateEvent
): Promise<T> {
  const stamped = { ...value, version: expectedVersion === null ? 0 : expectedVersion + 1 };
  const saved = await context.experienceState.compareAndSwap({
    projectId,
    key,
    expectedVersion,
    value: stamped,
    event
  });
  if (!saved) throw new VersionConflictError(expectedVersion);
  return stamped;
}

/** The versioned index behind the three panes. Everything here is a projection: the canonical record
 *  of the work is the Research / Verification / Report sessions, their messages and their attachments,
 *  so a lost or corrupt index is recoverable (see `rebuildFrom`) rather than fatal. Two agents writing
 *  into the evidence pool at once is the normal case, so every write is a compare-and-swap. */
export class ResearchDeskStore {
  constructor(readonly context: WorkplaceExperienceApiContext) {}

  private swap<T extends { version: number }>(
    projectId: string,
    key: string,
    expectedVersion: number | null,
    value: T,
    event: StateEvent
  ): Promise<T> {
    return swapRecord(this.context, projectId, key, expectedVersion, value, event);
  }

  async getSource(projectId: string, sourceId: string): Promise<SourceRef | null> {
    const record = await this.context.experienceState.get<unknown>(projectId, `${SOURCE_PREFIX}${sourceId}`);
    if (!record) return null;
    const source = normalizeSourceRef(record.value);
    if (source.projectId !== projectId || source.id !== sourceId || source.version !== record.version) {
      throw new Error(`corrupt Research Desk source record: ${sourceId}`);
    }
    return source;
  }

  async requireSource(projectId: string, sourceId: string): Promise<SourceRef> {
    const source = await this.getSource(projectId, sourceId);
    if (!source) throw new NotFoundError(`source not found: ${sourceId}`);
    return source;
  }

  async listSources(projectId: string): Promise<SourceRef[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, SOURCE_PREFIX);
    return records
      .map((record) => normalizeSourceRef(record.value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async putSource(source: SourceRef, expectedVersion: number | null): Promise<SourceRef> {
    return this.swap(source.projectId, `${SOURCE_PREFIX}${source.id}`, expectedVersion, source, {
      type: 'source.updated',
      sourceId: source.id,
      status: source.status
    });
  }

  async getClaim(projectId: string, evidenceId: string): Promise<EvidenceClaim | null> {
    const record = await this.context.experienceState.get<unknown>(projectId, `${EVIDENCE_PREFIX}${evidenceId}`);
    if (!record) return null;
    const claim = normalizeEvidenceClaim(record.value);
    if (claim.projectId !== projectId || claim.id !== evidenceId || claim.version !== record.version) {
      throw new Error(`corrupt Research Desk evidence record: ${evidenceId}`);
    }
    return claim;
  }

  async requireClaim(projectId: string, evidenceId: string): Promise<EvidenceClaim> {
    const claim = await this.getClaim(projectId, evidenceId);
    if (!claim) throw new NotFoundError(`evidence not found: ${evidenceId}`);
    return claim;
  }

  async listClaims(projectId: string): Promise<EvidenceClaim[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, EVIDENCE_PREFIX);
    return records
      .map((record) => normalizeEvidenceClaim(record.value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async claimsById(projectId: string): Promise<Map<string, EvidenceClaim>> {
    return new Map((await this.listClaims(projectId)).map((claim) => [claim.id, claim]));
  }

  async putClaim(claim: EvidenceClaim, expectedVersion: number | null): Promise<EvidenceClaim> {
    return this.swap(claim.projectId, `${EVIDENCE_PREFIX}${claim.id}`, expectedVersion, claim, {
      type: 'evidence.updated',
      evidenceId: claim.id,
      status: claim.status
    });
  }

  async applyContribution(projectId: string, contribution: EvidenceContribution, now: string): Promise<EvidenceClaim> {
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
      const claim = await this.requireClaim(projectId, contribution.claimId);
      const updated = applyEvidenceContribution(claim, claim.version, contribution, now);
      if (updated === claim) return claim;
      try {
        return await this.putClaim(updated, claim.version);
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
    throw new Error(`could not merge contribution after ${CAS_RETRY_LIMIT} attempts`);
  }

  async getAssignment(projectId: string, assignmentId: string): Promise<ResearchAssignment | null> {
    const record = await this.context.experienceState.get<unknown>(projectId, `${ASSIGNMENT_PREFIX}${assignmentId}`);
    if (!record) return null;
    const assignment = normalizeResearchAssignment(record.value);
    if (assignment.projectId !== projectId || assignment.id !== assignmentId || assignment.version !== record.version) {
      throw new Error(`corrupt Research Desk assignment record: ${assignmentId}`);
    }
    return assignment;
  }

  async requireAssignment(projectId: string, assignmentId: string): Promise<ResearchAssignment> {
    const assignment = await this.getAssignment(projectId, assignmentId);
    if (!assignment) throw new NotFoundError(`assignment not found: ${assignmentId}`);
    return assignment;
  }

  async listAssignments(projectId: string): Promise<ResearchAssignment[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, ASSIGNMENT_PREFIX);
    return records
      .map((record) => normalizeResearchAssignment(record.value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async putAssignment(assignment: ResearchAssignment, expectedVersion: number | null): Promise<ResearchAssignment> {
    return this.swap(assignment.projectId, `${ASSIGNMENT_PREFIX}${assignment.id}`, expectedVersion, assignment, {
      type: 'assignment.updated',
      assignmentId: assignment.id,
      state: assignment.state,
      role: assignment.role
    });
  }

  async completeAssignment(projectId: string, assignmentId: string, now: string): Promise<ResearchAssignment | null> {
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
      const assignment = await this.getAssignment(projectId, assignmentId);
      if (!assignment) return null;
      if (assignment.state === 'completed') return assignment;
      if (assignment.state === 'failed') return assignment;
      const completed = transitionResearchAssignment(assignment, assignment.version, 'completed', now);
      try {
        return await this.putAssignment(completed, assignment.version);
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
    throw new Error(`could not complete assignment after ${CAS_RETRY_LIMIT} attempts`);
  }

  async linkClaimToAssignmentBlock(
    projectId: string,
    assignmentId: string,
    claimId: string,
    sessionId: string,
    now: string
  ): Promise<Report | null> {
    const assignment = await this.getAssignment(projectId, assignmentId);
    if (
      !assignment ||
      !['queued', 'running', 'blocked'].includes(assignment.state) ||
      assignment.sessionId !== sessionId ||
      !assignment.targetBlockId
    ) {
      return null;
    }
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
      const report = await this.getReport(projectId);
      if (!report || report.state === 'published') return null;
      const block = report.blocks.find((entry) => entry.id === assignment.targetBlockId);
      if (!block) return null;
      if (block.evidenceIds.includes(claimId)) {
        await this.completeAssignment(projectId, assignment.id, now);
        return report;
      }
      const updated = patchBlock(
        report,
        report.version,
        block.id,
        { evidenceIds: [...block.evidenceIds, claimId] },
        'agent',
        now
      );
      try {
        const saved = await this.putReport(updated, report.version);
        await this.completeAssignment(projectId, assignment.id, now);
        return saved;
      } catch (error) {
        if (!(error instanceof VersionConflictError)) throw error;
      }
    }
    throw new Error(`could not link claim after ${CAS_RETRY_LIMIT} attempts`);
  }

  async getReport(projectId: string): Promise<Report | null> {
    const record = await this.context.experienceState.get<unknown>(projectId, REPORT_KEY);
    if (!record) return null;
    const report = normalizeReport(record.value);
    if (report.projectId !== projectId || report.version !== record.version) {
      throw new Error('corrupt Research Desk report record');
    }
    return report;
  }

  async requireReport(projectId: string): Promise<Report> {
    const report = await this.getReport(projectId);
    if (!report) throw new NotFoundError('no report in this project yet');
    return report;
  }

  async putReport(report: Report, expectedVersion: number | null): Promise<Report> {
    return this.swap(report.projectId, REPORT_KEY, expectedVersion, report, {
      type: 'report.updated',
      reportId: report.id,
      revision: report.revision,
      state: report.state
    });
  }

  /** Rebuild the index from the canonical sessions. The published transcript is the truth: every
   *  source, claim and report block was announced as a structured message by the agent that produced
   *  it, so a dropped index costs a re-read, not the research. */
  async rebuildFrom(
    sessionIds: readonly string[],
    decode: (
      message: { id: string; role: string; text: string; createdAt: string },
      sessionId: string
    ) => RebuiltRecord | null
  ): Promise<RebuildSummary> {
    const summary: RebuildSummary = { sources: 0, evidence: 0, reports: 0 };
    for (const sessionId of sessionIds) {
      let cursor: string | undefined;
      do {
        const page = await this.context.projectSessions.listMessages(sessionId, cursor);
        for (const message of page.items) {
          const record = decode(message, sessionId);
          if (!record) continue;
          if (record.kind === 'source') {
            await this.putSource(record.source, null);
            summary.sources += 1;
          } else if (record.kind === 'evidence') {
            await this.putClaim(record.claim, null);
            summary.evidence += 1;
          } else {
            await this.putReport(record.report, null);
            summary.reports += 1;
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return summary;
  }
}

export type RebuiltRecord =
  | { kind: 'source'; source: SourceRef }
  | { kind: 'evidence'; claim: EvidenceClaim }
  | { kind: 'report'; report: Report };

export interface RebuildSummary {
  sources: number;
  evidence: number;
  reports: number;
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class VersionConflictError extends Error {
  constructor(expectedVersion: number | null) {
    super(`version conflict: expected ${expectedVersion}`);
    this.name = 'VersionConflictError';
  }
}
