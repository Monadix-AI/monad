import type {
  EvidenceClaim,
  Report,
  ReportBlock,
  SourceRef
} from '../../src/experiences/research-desk/domain/index.ts';

import { describe, expect, test } from 'bun:test';

import {
  decisionBody,
  firstBlockedBlock,
  parseCoverage,
  parseOverviewPayload,
  parsePublishResult,
  publishConflict,
  replaceClaim,
  reportBlockIsBlocked,
  researchViewModel,
  sourceStatusDetail,
  sourceStatusTone
} from '../../src/experiences/research-desk/client-logic.ts';

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
});
