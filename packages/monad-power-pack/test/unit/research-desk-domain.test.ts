import { describe, expect, test } from 'bun:test';

import {
  addCitation,
  applyEvidenceContribution,
  blockSource,
  captureSource,
  coverageFor,
  decideClaim,
  isCitable,
  makeEvidenceClaim,
  makeEvidenceContribution,
  makeReport,
  makeResearchAssignment,
  makeSourceRef,
  manifestEntries,
  markSourceRot,
  normalizeEvidenceClaim,
  PublishBlockedError,
  patchBlock,
  publishBlockers,
  publishReport,
  reopenClaim,
  startNextRevision,
  statusFromCitations,
  transitionResearchAssignment,
  upsertBlock
} from '../../src/experiences/research-desk/domain/index.ts';

const NOW = '2026-08-13T10:00:00.000Z';
const LATER = '2026-08-13T11:00:00.000Z';

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src_a',
    projectId: 'prj_1',
    kind: 'url' as const,
    title: 'Vendor A pricing page',
    locator: 'https://example.test/pricing',
    sessionId: 'ses_research',
    capturedByMemberId: 'mesh-agent:researcher',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  return makeEvidenceClaim({
    id: 'evd_1',
    projectId: 'prj_1',
    text: 'Competitors broadly adopt usage-based pricing',
    proposedByMemberId: 'mesh-agent:researcher',
    sessionId: 'ses_research',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  });
}

function citation(overrides: Record<string, unknown> = {}) {
  return {
    sourceId: 'src_a',
    excerpt: 'moving to consumption pricing across the portfolio',
    locator: 'p.2',
    stance: 'support' as const,
    addedByMemberId: 'mesh-agent:researcher',
    ...overrides
  };
}

function factualBlock(overrides: Record<string, unknown> = {}) {
  return {
    id: 'blk_landscape',
    kind: 'factual' as const,
    heading: 'Competitive landscape',
    markdown: 'Competitors broadly adopt usage-based pricing.',
    evidenceIds: ['evd_1'],
    kindChangedByHuman: false,
    ...overrides
  };
}

describe('source lifecycle', () => {
  test('capturing a source records its fingerprint and makes it citable', () => {
    const captured = captureSource(makeSource(), 0, { fingerprint: 'fp_3f9a', type: 'primary' }, NOW);

    expect(captured.status).toBe('available');
    expect(captured.fingerprint).toBe('fp_3f9a');
    expect(captured.type).toBe('primary');
    expect(captured.capturedAt).toBe(NOW);
    expect(captured.version).toBe(1);
    expect(isCitable(captured)).toBe(true);
  });

  test('a recheck marks the source changed without replacing the cited snapshot', () => {
    const captured = captureSource(makeSource(), 0, { fingerprint: 'fp_3f9a' }, NOW);

    const rechecked = markSourceRot(captured, 1, 'changed', 'page content differs from the snapshot', LATER);

    expect(rechecked.status).toBe('changed');
    expect(rechecked.fingerprint).toBe('fp_3f9a');
    expect(rechecked.capturedAt).toBe(NOW);
    expect(rechecked.recheckedAt).toBe(LATER);
    expect(isCitable(rechecked)).toBe(true);
  });

  test('a source that could not be read keeps its reason and cannot back a citation', () => {
    const blocked = blockSource(makeSource(), 0, 'blocked', 'login required', NOW);

    expect(blocked.status).toBe('blocked');
    expect(blocked.statusReason).toBe('login required');
    expect(isCitable(blocked)).toBe(false);
  });

  test('blocking a source without a reason is refused', () => {
    expect(() => blockSource(makeSource(), 0, 'failed', '   ', NOW)).toThrow('a blocked source requires a reason');
  });

  test('a stale expected version is refused instead of overwriting a concurrent write', () => {
    const captured = captureSource(makeSource(), 0, { fingerprint: 'fp_3f9a' }, NOW);

    expect(() => captureSource(captured, 0, { fingerprint: 'fp_other' }, LATER)).toThrow(
      'version conflict: expected 0, current 1'
    );
  });
});

describe('evidence status from material', () => {
  test('opposing material contests a claim that also has support', () => {
    const supported = addCitation(claim(), 0, citation(), NOW);
    const contested = addCitation(supported, 1, citation({ sourceId: 'src_b', stance: 'oppose' }), LATER);

    expect(supported.status).toBe('supported');
    expect(contested.status).toBe('contested');
    expect(contested.citations.map((entry) => entry.stance)).toEqual(['support', 'oppose']);
  });

  test('an uncited claim reads as unverified', () => {
    expect(statusFromCitations([])).toBe('unverified');
  });
});

describe('mesh evidence contributions', () => {
  test('an opposing citation records canonical provenance and contests an existing claim', () => {
    const contribution = makeEvidenceContribution({
      id: 'ctb_1',
      claimId: 'evd_1',
      assignmentId: 'asg_1',
      memberId: 'mesh-agent:evidence-engineer',
      sessionId: 'ses_verify',
      messageId: 'msg_verify',
      kind: 'citation',
      payload: {
        sourceId: 'src_b',
        excerpt: 'the comparable cohort retained seat pricing',
        locator: null,
        stance: 'oppose'
      },
      createdAt: LATER
    });

    const updated = applyEvidenceContribution(addCitation(claim(), 0, citation(), NOW), 1, contribution, LATER);

    expect(updated.status).toBe('contested');
    expect(updated.citations).toEqual([
      { ...citation(), addedAt: NOW },
      {
        sourceId: 'src_b',
        excerpt: 'the comparable cohort retained seat pricing',
        locator: null,
        stance: 'oppose',
        addedByMemberId: 'mesh-agent:evidence-engineer',
        addedAt: LATER
      }
    ]);
    expect(updated.contributions).toEqual([contribution]);
    expect(updated.version).toBe(2);
  });

  test('repeating a contribution id is a no-op with no version or timestamp change', () => {
    const contribution = makeEvidenceContribution({
      id: 'ctb_repeat',
      claimId: 'evd_1',
      assignmentId: null,
      memberId: 'mesh-agent:evidence-engineer',
      sessionId: 'ses_verify',
      messageId: 'msg_verify',
      kind: 'challenge',
      payload: { reason: 'the sample mixes incomparable vendors' },
      createdAt: NOW
    });
    const once = applyEvidenceContribution(claim(), 0, contribution, NOW);

    expect(applyEvidenceContribution(once, 1, contribution, LATER)).toEqual(once);
  });

  test('a challenge after a human ruling remains visible without reopening the ruling', () => {
    const accepted = decideClaim(claim(), 0, { status: 'accepted', reason: 'narrowed to the comparable cohort' }, NOW);
    const challenged = applyEvidenceContribution(
      accepted,
      1,
      makeEvidenceContribution({
        id: 'ctb_challenge',
        claimId: 'evd_1',
        assignmentId: null,
        memberId: 'mesh-agent:evidence-engineer',
        sessionId: 'ses_verify',
        messageId: 'msg_verify',
        kind: 'challenge',
        payload: { reason: 'a newly launched vendor falls outside the captured cohort' },
        createdAt: LATER
      }),
      LATER
    );

    expect(challenged.status).toBe('accepted');
    expect(challenged.decidedBy).toBe('human');
    expect(challenged.decisionReason).toBe('narrowed to the comparable cohort');
    expect(challenged.contributions.map((entry) => entry.kind)).toEqual(['challenge']);
  });

  test('legacy persisted claims normalize with an empty contribution ledger', () => {
    const current = claim();
    const { contributions: _contributions, ...legacy } = current;

    expect(normalizeEvidenceClaim(legacy)).toEqual(current);
  });
});

describe('research assignments', () => {
  test('an assignment moves from queued through running to completed with an audit receipt', () => {
    const queued = makeResearchAssignment({
      id: 'asg_1',
      projectId: 'prj_1',
      role: 'evidence-engineer',
      targetClaimId: 'evd_1',
      sessionId: 'ses_verify',
      memberId: 'mesh-agent:evidence-engineer',
      objective: 'Challenge the pricing claim with a comparable cohort',
      contextReceipt: {
        brief: 'Decide whether usage pricing fits the launch',
        sourceIds: ['src_a'],
        claimIds: ['evd_1'],
        blockIds: ['blk_landscape']
      },
      createdAt: NOW
    });
    const running = transitionResearchAssignment(queued, 0, 'running', NOW, { runId: 'run_1' });
    const completed = transitionResearchAssignment(running, 1, 'completed', LATER);

    expect(completed).toEqual({
      ...queued,
      state: 'completed',
      runId: 'run_1',
      version: 2,
      updatedAt: LATER,
      completedAt: LATER
    });
    expect(() => transitionResearchAssignment(completed, 2, 'running', LATER)).toThrow(
      'a completed assignment is terminal'
    );
  });

  test('a queued assignment can fail before a run id exists and records the exact reason', () => {
    const queued = makeResearchAssignment({
      id: 'asg_failed',
      projectId: 'prj_1',
      role: 'researcher',
      sessionId: 'ses_research',
      memberId: 'mesh-agent:researcher',
      objective: 'Find primary evidence for the missing report block',
      contextReceipt: { brief: 'Pricing research', sourceIds: [], claimIds: [], blockIds: ['blk_landscape'] },
      createdAt: NOW
    });

    expect(
      transitionResearchAssignment(queued, 0, 'failed', LATER, {
        errorReason: 'the assigned session could not start'
      })
    ).toEqual({
      ...queued,
      state: 'failed',
      version: 1,
      updatedAt: LATER,
      errorReason: 'the assigned session could not start'
    });
  });
});

describe('human decision', () => {
  test('accepting with a narrowed wording rewrites the claim and records who ruled and why', () => {
    const contested = addCitation(claim(), 0, citation({ stance: 'oppose' }), NOW);

    const decided = decideClaim(
      contested,
      1,
      {
        status: 'accepted',
        editedText: 'Developer-tool vendors in this sample more often adopt usage-based pricing',
        reason: 'sample mixes infra vendors; narrowed to the comparable subset'
      },
      LATER
    );

    expect(decided.text).toBe('Developer-tool vendors in this sample more often adopt usage-based pricing');
    expect(decided.status).toBe('accepted');
    expect(decided.decidedBy).toBe('human');
    expect(decided.decisionReason).toBe('sample mixes infra vendors; narrowed to the comparable subset');
    expect(decided.decidedAt).toBe(LATER);
  });

  test('a decision without a reason is refused', () => {
    expect(() => decideClaim(claim(), 0, { status: 'accepted', reason: '  ' }, NOW)).toThrow(
      'a decision requires a reason'
    );
  });

  test('material arriving after a ruling does not silently reopen it', () => {
    const decided = decideClaim(claim(), 0, { status: 'accepted', reason: 'checked both pages' }, NOW);

    const withOpposing = addCitation(decided, 1, citation({ sourceId: 'src_b', stance: 'oppose' }), LATER);

    expect(withOpposing.status).toBe('accepted');
    expect(withOpposing.decisionReason).toBe('checked both pages');
  });

  test('reopening a ruled claim returns it to the material and clears the decision record', () => {
    const decided = decideClaim(
      addCitation(claim(), 0, citation({ stance: 'oppose' }), NOW),
      1,
      { status: 'accepted', reason: 'accepted anyway' },
      LATER
    );

    const reopened = reopenClaim(decided, 2, LATER);

    expect(reopened.status).toBe('contested');
    expect(reopened.decidedBy).toBeNull();
    expect(reopened.decisionReason).toBeNull();
    expect(reopened.decidedAt).toBeNull();
  });
});

describe('report coverage and the publish gate', () => {
  const acceptedClaim = decideClaim(claim(), 0, { status: 'accepted', reason: 'verified' }, NOW);
  const contestedClaim = addCitation(claim({ id: 'evd_2' }), 0, citation({ stance: 'oppose' }), NOW);

  test('a factual block citing only a contested claim reports the requirement as still open', () => {
    const coverage = coverageFor(factualBlock({ evidenceIds: ['evd_2'] }), new Map([['evd_2', contestedClaim]]));

    expect(coverage).toEqual({
      blockId: 'blk_landscape',
      heading: 'Competitive landscape',
      kind: 'factual',
      accepted: 0,
      contested: 1,
      missing: 1
    });
  });

  test('an analysis block needs no citation', () => {
    const coverage = coverageFor(factualBlock({ kind: 'analysis', evidenceIds: [] }), new Map());

    expect(coverage.missing).toBe(0);
  });

  test('publishing is refused while a factual block has no accepted evidence, and names it', () => {
    const report = upsertBlock(makeReport(reportInput()), 0, factualBlock({ evidenceIds: ['evd_2'] }), NOW);
    const claims = new Map([['evd_2', contestedClaim]]);

    expect(publishBlockers(report, claims).map((blocker) => blocker.heading)).toEqual(['Competitive landscape']);
    expect(() => publishReport(report, 1, claims, LATER)).toThrow(PublishBlockedError);
  });

  test('publishing succeeds once the block cites an accepted claim, and freezes the revision', () => {
    const report = upsertBlock(makeReport(reportInput()), 0, factualBlock(), NOW);
    const claims = new Map([['evd_1', acceptedClaim]]);

    const published = publishReport(report, 1, claims, LATER);

    expect(published.state).toBe('published');
    expect(published.publishedAt).toBe(LATER);
    expect(() => upsertBlock(published, published.version, factualBlock({ id: 'blk_2' }), LATER)).toThrow(
      'a published revision is immutable; start the next revision instead'
    );
  });

  test('retyping a factual block to analysis is allowed for a human and leaves a mark', () => {
    const report = upsertBlock(makeReport(reportInput()), 0, factualBlock({ evidenceIds: [] }), NOW);

    const retyped = patchBlock(report, 1, 'blk_landscape', { kind: 'analysis' }, 'human', LATER);

    expect(retyped.blocks[0]?.kind).toBe('analysis');
    expect(retyped.blocks[0]?.kindChangedByHuman).toBe(true);
    expect(publishBlockers(retyped, new Map())).toEqual([]);
  });

  test('an agent cannot retype a block past the gate', () => {
    const report = upsertBlock(makeReport(reportInput()), 0, factualBlock({ evidenceIds: [] }), NOW);

    expect(() => patchBlock(report, 1, 'blk_landscape', { kind: 'analysis' }, 'agent', LATER)).toThrow(
      'only a human changes a report block kind'
    );
  });

  test('the next revision starts as a fresh draft and leaves the published one untouched', () => {
    const report = upsertBlock(makeReport(reportInput()), 0, factualBlock(), NOW);
    const published = publishReport(report, 1, new Map([['evd_1', acceptedClaim]]), LATER);

    const next = startNextRevision(published, 'rep_2', LATER);

    expect(next.revision).toBe(2);
    expect(next.state).toBe('draft');
    expect(next.publishedAt).toBeNull();
    expect(next.version).toBe(0);
    expect(published.state).toBe('published');
  });
});

describe('source manifest', () => {
  test('the manifest lists every source behind a cited claim with its capture time and fingerprint', () => {
    const cited = addCitation(claim(), 0, citation(), NOW);
    const report = upsertBlock(makeReport(reportInput()), 0, factualBlock(), NOW);
    const sources = new Map([
      [
        'src_a',
        {
          id: 'src_a',
          title: 'Vendor A pricing page',
          locator: 'https://example.test/pricing',
          capturedAt: NOW,
          fingerprint: 'fp_3f9a',
          status: 'changed'
        }
      ],
      [
        'src_unused',
        {
          id: 'src_unused',
          title: 'Unused',
          locator: 'https://example.test/other',
          capturedAt: NOW,
          fingerprint: 'fp_zz',
          status: 'available'
        }
      ]
    ]);

    expect(manifestEntries(report, new Map([['evd_1', cited]]), sources)).toEqual([
      {
        sourceId: 'src_a',
        title: 'Vendor A pricing page',
        locator: 'https://example.test/pricing',
        capturedAt: NOW,
        fingerprint: 'fp_3f9a',
        status: 'changed'
      }
    ]);
  });
});

function makeSource() {
  return makeSourceRef(source());
}

function reportInput() {
  return {
    id: 'rep_1',
    projectId: 'prj_1',
    title: 'Usage-based pricing for the EU launch',
    question: 'Should a small B2B SaaS adopt usage-based pricing for its next European launch?',
    sessionId: 'ses_report',
    createdAt: NOW,
    updatedAt: NOW
  };
}
