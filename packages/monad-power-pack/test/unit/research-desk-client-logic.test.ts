import type {
  CrossRead,
  EvidenceClaim,
  Report,
  ReportBlock,
  SourceRef,
  SourceVisibility
} from '../../src/experiences/research-desk/domain/index.ts';

import { describe, expect, test } from 'bun:test';

import {
  crossReadCanBeRuled,
  decisionBody,
  firstBlockedBlock,
  parseCoverage,
  parseCrossReadsPayload,
  parseNotesPayload,
  parseOverviewPayload,
  parsePublishResult,
  parseTransformationsPayload,
  parseVisibilityPayload,
  publishConflict,
  replaceClaim,
  reportBlockIsBlocked,
  researchViewModel,
  sourceStatusDetail,
  sourceStatusTone,
  toggledVisibilityRule,
  visibleSourceIds
} from '../../src/experiences/research-desk/client-logic.ts';
import { BUILT_IN_TRANSFORMATIONS } from '../../src/experiences/research-desk/domain/index.ts';

const claim = (status: EvidenceClaim['status'] = 'contested'): EvidenceClaim => ({
  schemaVersion: 1,
  id: 'evidence-4',
  projectId: 'project-a',
  text: 'Competitors broadly adopt usage-based pricing',
  status,
  citations: [
    {
      sourceId: 'source-a',
      excerpt: 'Moving to consumption pricing',
      locator: 'Pricing, paragraph 2',
      stance: 'support',
      addedByMemberId: 'researcher',
      addedAt: '2026-08-13T10:00:00.000Z'
    }
  ],
  derivations: [],
  proposedByMemberId: 'researcher',
  sessionId: 'session-research',
  messageId: 'message-a',
  decidedBy: status === 'accepted' ? 'human' : null,
  decisionReason: status === 'accepted' ? 'Narrowed to the comparable sample.' : null,
  decidedAt: status === 'accepted' ? '2026-08-13T10:04:00.000Z' : null,
  version: status === 'accepted' ? 1 : 0,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z'
});

const reportBlock: ReportBlock = {
  id: 'block-market',
  kind: 'factual',
  heading: 'Competitive landscape',
  markdown: 'Competitors broadly adopt usage-based pricing.',
  evidenceIds: ['evidence-4'],
  kindChangedByHuman: false
};

const report: Report = {
  schemaVersion: 1,
  id: 'report-a',
  projectId: 'project-a',
  title: 'Pricing memo',
  question: 'Should we adopt usage-based pricing?',
  doneWhen: 'Every factual claim has accepted evidence.',
  state: 'draft',
  revision: 1,
  blocks: [reportBlock],
  sessionId: 'session-report',
  publishedAt: null,
  version: 0,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z'
};

const source = (id: string): SourceRef => ({
  schemaVersion: 1,
  id,
  projectId: 'project-a',
  kind: 'url',
  type: 'primary',
  title: id,
  locator: `https://example.com/${id}`,
  statusReason: null,
  status: 'available',
  sessionId: 'session-research',
  messageId: null,
  artifactPath: null,
  capturedByMemberId: 'researcher',
  recheckedAt: null,
  capturedAt: '2026-08-13T09:14:00.000Z',
  fingerprint: `fingerprint-${id}`,
  version: 0,
  createdAt: '2026-08-13T09:10:00.000Z',
  updatedAt: '2026-08-13T09:10:00.000Z'
});

const crossRead = (states: Array<'pending' | 'answered' | 'failed'>): CrossRead => ({
  schemaVersion: 1,
  id: 'cross-read-a',
  projectId: 'project-a',
  question: 'Do the vendors describe the same pricing model?',
  sourceIds: ['source-a'],
  readings: states.map((state, index) => ({
    memberId: `member-${index + 1}`,
    provider: `provider-${index + 1}`,
    sessionId: `session-${index + 1}`,
    answer: state === 'answered' ? `Answer ${index + 1}` : null,
    citations: [],
    state,
    failureReason: state === 'failed' ? 'The reader failed.' : null,
    answeredAt: state === 'answered' ? '2026-08-13T10:04:00.000Z' : null
  })),
  verdict: null,
  verdictReason: null,
  producedEvidenceId: null,
  version: 0,
  createdAt: '2026-08-13T10:00:00.000Z',
  updatedAt: '2026-08-13T10:00:00.000Z'
});

describe('research desk client logic', () => {
  test('selecting evidence links its exact source and report block while retaining publish coverage', () => {
    const view = researchViewModel([claim()], report, 'evidence-4');

    expect({
      selectedClaimId: view.selectedClaim?.id,
      linkedSourceIds: [...view.linkedSourceIds],
      linkedReportBlockIds: [...view.linkedReportBlockIds],
      coverage: view.coverage
    }).toEqual({
      selectedClaimId: 'evidence-4',
      linkedSourceIds: ['source-a'],
      linkedReportBlockIds: ['block-market'],
      coverage: [
        {
          blockId: 'block-market',
          heading: 'Competitive landscape',
          kind: 'factual',
          accepted: 0,
          contested: 1,
          missing: 1
        }
      ]
    });
  });

  test('a completed decision replaces the claim and clears its report blocker in the same view model', () => {
    const updated = claim('accepted');
    const evidence = replaceClaim([claim()], updated);
    const view = researchViewModel(evidence, report, 'evidence-4');

    expect({ evidence, coverage: view.coverage }).toEqual({
      evidence: [updated],
      coverage: [
        {
          blockId: 'block-market',
          heading: 'Competitive landscape',
          kind: 'factual',
          accepted: 1,
          contested: 0,
          missing: 0
        }
      ]
    });
  });

  test('decision requests require a reason and preserve a narrowed accepted claim', () => {
    expect(() => decisionBody('accepted', '   ', 'Narrow claim', claim().text)).toThrow(
      'Add a reason for this decision.'
    );
    expect(
      decisionBody('accepted', '  Comparable sample only.  ', '  Developer-tool vendors adopt it.  ', claim().text)
    ).toEqual({
      status: 'accepted',
      reason: 'Comparable sample only.',
      editedText: 'Developer-tool vendors adopt it.'
    });
  });

  test('changed and unreachable sources keep the captured snapshot visible in their status detail', () => {
    const source: SourceRef = {
      schemaVersion: 1,
      id: 'source-a',
      projectId: 'project-a',
      kind: 'url',
      type: 'primary',
      title: 'Vendor pricing',
      locator: 'https://example.com/pricing',
      statusReason: 'The upstream page changed.',
      status: 'changed',
      sessionId: 'session-research',
      messageId: 'message-source',
      artifactPath: 'sources/source-a.html',
      capturedByMemberId: 'researcher',
      recheckedAt: null,
      capturedAt: '2026-08-13T09:14:00.000Z',
      fingerprint: '3f9a1234567890c1',
      version: 2,
      createdAt: '2026-08-13T09:10:00.000Z',
      updatedAt: '2026-08-13T10:14:00.000Z'
    };

    expect([
      sourceStatusDetail(source),
      sourceStatusDetail({ ...source, status: 'unreachable', statusReason: 'Offline.' })
    ]).toEqual([
      'The upstream page changed. · snapshot kept · fp 3f9a12…90c1',
      'Offline. · snapshot kept · fp 3f9a12…90c1'
    ]);
  });

  test('source status presentation keeps failures distinct from source rot and healthy snapshots', () => {
    const statuses: SourceRef['status'][] = ['blocked', 'changed', 'available'];
    expect(statuses.map(sourceStatusTone)).toEqual(['destructive', 'warning', 'success']);
  });

  test('frozen API envelopes parse into the exact overview and coverage contracts', () => {
    const overview = {
      projectId: 'project-a',
      report: {
        id: 'report-a',
        title: 'Pricing memo',
        question: 'Should we adopt usage-based pricing?',
        doneWhen: 'Every factual claim has accepted evidence.',
        state: 'draft' as const,
        revision: 1
      },
      stage: 'verifying' as const,
      members: [
        {
          memberId: 'member-researcher',
          role: 'researcher' as const,
          displayName: 'Researcher',
          sessionId: null
        }
      ],
      usage: { tokens: null, cost: null },
      counts: { sources: 4, claims: 2, needsYou: 1 }
    };
    const coverage = [
      {
        blockId: 'block-market',
        heading: 'Competitive landscape',
        kind: 'factual' as const,
        accepted: 0,
        contested: 1,
        missing: 1
      }
    ];

    expect({ overview: parseOverviewPayload({ overview }), coverage: parseCoverage({ coverage }) }).toEqual({
      overview,
      coverage
    });
  });

  test('publish approval cancellation remains a non-published result', () => {
    expect(parsePublishResult({ published: false, report, manifest: [] })).toEqual({
      published: false,
      report,
      manifest: []
    });
  });

  test('a publish conflict names exact blocked blocks and navigates to the first one', () => {
    const conflict = publishConflict({
      blockedBlocks: [
        {
          blockId: 'block-market',
          heading: 'Competitive landscape',
          kind: 'factual',
          accepted: 0,
          contested: 1,
          missing: 1
        },
        {
          blockId: 'block-buyers',
          heading: 'European buyer expectations',
          kind: 'factual',
          accepted: 0,
          contested: 0,
          missing: 1
        }
      ]
    });

    expect({ conflict, firstBlockedBlock: firstBlockedBlock(conflict) }).toEqual({
      conflict: {
        blockedBlocks: [
          {
            blockId: 'block-market',
            heading: 'Competitive landscape',
            kind: 'factual',
            accepted: 0,
            contested: 1,
            missing: 1
          },
          {
            blockId: 'block-buyers',
            heading: 'European buyer expectations',
            kind: 'factual',
            accepted: 0,
            contested: 0,
            missing: 1
          }
        ]
      },
      firstBlockedBlock: 'block-market'
    });
  });

  test('analysis text never becomes a publish blocker even if a stale coverage value says missing', () => {
    expect(
      reportBlockIsBlocked(
        { ...reportBlock, kind: 'analysis' },
        {
          blockId: 'block-market',
          heading: 'Competitive landscape',
          kind: 'analysis',
          accepted: 0,
          contested: 0,
          missing: 1
        }
      )
    ).toBe(false);
  });

  test('cross-read ruling stays locked until two independent readers answer', () => {
    expect([
      crossReadCanBeRuled(crossRead(['answered', 'pending'])),
      crossReadCanBeRuled(crossRead(['answered', 'failed'])),
      crossReadCanBeRuled(crossRead(['answered', 'answered']))
    ]).toEqual([false, false, true]);
  });

  test('visibility defaults to every source and collapses an all-selected rule back to null', () => {
    const sources = [source('source-a'), source('source-b')];
    const visibility: SourceVisibility = {
      schemaVersion: 1,
      projectId: 'project-a',
      rules: [],
      version: 0,
      updatedAt: '2026-08-13T10:00:00.000Z'
    };
    const restricted = toggledVisibilityRule(visibility, 'member-a', sources, 'source-a', false);
    const explicit: SourceVisibility = {
      ...visibility,
      rules: [{ memberId: 'member-a', sourceIds: restricted }]
    };

    expect({
      defaultSourceIds: visibleSourceIds(visibility, 'member-a', sources),
      restricted,
      restored: toggledVisibilityRule(explicit, 'member-a', sources, 'source-a', true)
    }).toEqual({
      defaultSourceIds: ['source-a', 'source-b'],
      restricted: ['source-b'],
      restored: null
    });
  });

  test('mesh collection envelopes preserve independent readings, scratch notes, and the exact visibility scope', () => {
    const researchNote = {
      schemaVersion: 1 as const,
      id: 'note-a',
      projectId: 'project-a',
      text: 'Check the annual contract assumption.',
      authoredBy: 'human' as const,
      authorMemberId: null,
      sourceId: 'source-a',
      evidenceId: null,
      promotedEvidenceId: null,
      version: 0,
      createdAt: '2026-08-13T10:00:00.000Z',
      updatedAt: '2026-08-13T10:00:00.000Z'
    };
    const visibility: SourceVisibility = {
      schemaVersion: 1,
      projectId: 'project-a',
      rules: [{ memberId: 'member-1', sourceIds: ['source-a'] }],
      version: 1,
      updatedAt: '2026-08-13T10:00:00.000Z'
    };
    const matrix = [{ memberId: 'member-1', sourceId: 'source-a', canRead: true }];
    const scope = 'Controls which sources Research Desk sends to each member. It is not network isolation.';

    expect({
      crossReads: parseCrossReadsPayload({ crossReads: [crossRead(['answered', 'answered'])] }),
      notes: parseNotesPayload({ notes: [researchNote] }),
      visibility: parseVisibilityPayload({ visibility, matrix, scope })
    }).toEqual({
      crossReads: [crossRead(['answered', 'answered'])],
      notes: [researchNote],
      visibility: { visibility, matrix, scope }
    });
  });

  test('transformation envelopes retain null provider usage instead of producing a partial total', () => {
    const transformation = BUILT_IN_TRANSFORMATIONS[1];
    if (!transformation) throw new Error('the counterexample transformation is required');
    const run = {
      schemaVersion: 1 as const,
      id: 'run-a',
      projectId: 'project-a',
      transformationId: transformation.id,
      sourceId: 'source-a',
      memberId: 'member-2',
      sessionId: 'session-run-a',
      state: 'settled' as const,
      producedEvidenceIds: ['evidence-4'],
      tokens: null,
      cost: null,
      failureReason: null,
      version: 1,
      startedAt: '2026-08-13T10:00:00.000Z',
      settledAt: '2026-08-13T10:02:00.000Z'
    };
    const spend = {
      transformationId: transformation.id,
      label: transformation.label,
      tier: transformation.tier,
      runs: 1,
      tokens: null,
      cost: null
    };

    expect(parseTransformationsPayload({ transformations: [transformation], runs: [run], spend: [spend] })).toEqual({
      transformations: [transformation],
      runs: [run],
      spend: [spend]
    });
  });
});
