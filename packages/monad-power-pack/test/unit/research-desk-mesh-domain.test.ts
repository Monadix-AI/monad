import type { CrossReading, SourceRef } from '../../src/experiences/research-desk/domain/index.ts';

import { describe, expect, test } from 'bun:test';

import {
  BUILT_IN_TRANSFORMATIONS,
  canRead,
  claimFromCrossRead,
  editNote,
  failReading,
  failRun,
  isComplete,
  makeCrossRead,
  makeNote,
  makeSourceRef,
  makeTransformationRun,
  makeVisibility,
  markNotePromoted,
  readableSources,
  recordReading,
  ruleOnCrossRead,
  setRule,
  settleRun,
  spendByTransformation,
  visibilityMatrix
} from '../../src/experiences/research-desk/domain/index.ts';

const NOW = '2026-08-19T10:00:00.000Z';
const LATER = '2026-08-19T11:00:00.000Z';
const PROJECT = 'prj_1';

function pendingReading(memberId: string, provider: string): CrossReading {
  return {
    memberId,
    provider,
    sessionId: `ses_${memberId}`,
    answer: null,
    citations: [],
    state: 'pending',
    failureReason: null,
    answeredAt: null
  };
}

function crossRead() {
  return makeCrossRead({
    id: 'xr_1',
    projectId: PROJECT,
    question: 'Do competitors price by usage?',
    sourceIds: ['src_a'],
    readings: [pendingReading('claude', 'anthropic'), pendingReading('codex', 'openai')],
    createdAt: NOW,
    updatedAt: NOW
  });
}

function bothAnswered() {
  const first = recordReading(
    crossRead(),
    0,
    {
      memberId: 'claude',
      answer: 'Yes — the portfolio moved to consumption pricing.',
      citations: [{ sourceId: 'src_a', excerpt: 'moving to consumption pricing', locator: 'p.2' }]
    },
    NOW
  );
  return recordReading(
    first,
    1,
    {
      memberId: 'codex',
      answer: 'No — only the infrastructure tier did.',
      citations: [{ sourceId: 'src_a', excerpt: 'infrastructure tier only', locator: 'p.4' }]
    },
    LATER
  );
}

function source(id: string): SourceRef {
  return makeSourceRef({
    id,
    projectId: PROJECT,
    kind: 'url',
    title: id,
    locator: `https://example.test/${id}`,
    sessionId: 'ses_research',
    capturedByMemberId: 'claude',
    createdAt: NOW
  });
}

describe('cross-read', () => {
  test('a cross-read settles only once every requested reader has answered or failed', () => {
    const partial = recordReading(crossRead(), 0, { memberId: 'claude', answer: 'Yes', citations: [] }, NOW);

    expect(isComplete(partial)).toBe(false);
    expect(isComplete(failReading(partial, 1, 'codex', 'provider timed out', LATER))).toBe(true);
  });

  test('a reading from a member who was never asked is refused', () => {
    expect(() => recordReading(crossRead(), 0, { memberId: 'gemini', answer: 'Yes', citations: [] }, NOW)).toThrow(
      'no reading was requested from gemini'
    );
  });

  test('ruling before both readers settle is refused, so a verdict cannot be based on one voice', () => {
    const partial = recordReading(crossRead(), 0, { memberId: 'claude', answer: 'Yes', citations: [] }, NOW);

    expect(() => ruleOnCrossRead(partial, 1, { verdict: 'agreed', reason: 'looks fine' }, LATER)).toThrow(
      'every reading must settle before this can be ruled on'
    );
  });

  test('a verdict requires a reason', () => {
    expect(() => ruleOnCrossRead(bothAnswered(), 2, { verdict: 'disagreed', reason: '  ' }, LATER)).toThrow(
      'a cross-read verdict requires a reason'
    );
  });

  test('a disagreement carries both vendors material into one claim, opposing side included', () => {
    const ruled = ruleOnCrossRead(
      bothAnswered(),
      2,
      { verdict: 'disagreed', reason: 'they read the same page differently' },
      LATER
    );

    const claim = claimFromCrossRead(ruled, {
      id: 'evd_1',
      text: 'Competitors price by usage',
      proposedByMemberId: 'claude',
      sessionId: 'ses_research'
    });

    expect(claim.citations).toEqual([
      {
        sourceId: 'src_a',
        excerpt: 'moving to consumption pricing',
        locator: 'p.2',
        stance: 'support',
        addedByMemberId: 'claude'
      },
      {
        sourceId: 'src_a',
        excerpt: 'infrastructure tier only',
        locator: 'p.4',
        stance: 'oppose',
        addedByMemberId: 'codex'
      }
    ]);
  });

  test('an agreement carries every readers material as support', () => {
    const ruled = ruleOnCrossRead(bothAnswered(), 2, { verdict: 'agreed', reason: 'same conclusion' }, LATER);

    const claim = claimFromCrossRead(ruled, {
      id: 'evd_1',
      text: 'Competitors price by usage',
      proposedByMemberId: 'claude',
      sessionId: 'ses_research'
    });

    expect(claim.citations.map((citation) => citation.stance)).toEqual(['support', 'support']);
  });

  test('an unruled cross-read produces no claim', () => {
    expect(() =>
      claimFromCrossRead(bothAnswered(), {
        id: 'evd_1',
        text: 'Competitors price by usage',
        proposedByMemberId: 'claude',
        sessionId: 'ses_research'
      })
    ).toThrow('an unruled cross-read does not produce a claim');
  });
});

describe('transformation runs and spend', () => {
  test('the built-in recipes price the mechanical step below the hardest reasoning step', () => {
    const byId = new Map(BUILT_IN_TRANSFORMATIONS.map((entry) => [entry.id, entry]));

    expect(byId.get('extract-claims')?.tier).toBe('fast');
    expect(byId.get('find-counterexamples')?.tier).toBe('power');
    expect(byId.get('find-counterexamples')?.role).toBe('evidence-engineer');
  });

  test('a settled run reports what the provider reported and links what it produced', () => {
    const run = makeTransformationRun({
      id: 'run_1',
      projectId: PROJECT,
      transformationId: 'extract-claims',
      memberId: 'claude',
      sessionId: 'ses_research',
      startedAt: NOW
    });

    const settled = settleRun(run, 0, { producedEvidenceIds: ['evd_1', 'evd_2'], tokens: 1_200 }, LATER);

    expect(settled.state).toBe('settled');
    expect(settled.producedEvidenceIds).toEqual(['evd_1', 'evd_2']);
    expect(settled.tokens).toBe(1_200);
    expect(settled.cost).toBeNull();
    expect(settled.settledAt).toBe(LATER);
  });

  test('a failed run keeps its reason and produces nothing', () => {
    const run = makeTransformationRun({
      id: 'run_1',
      projectId: PROJECT,
      transformationId: 'extract-claims',
      memberId: 'claude',
      sessionId: 'ses_research',
      startedAt: NOW
    });

    const failed = failRun(run, 0, 'the source was unreachable', LATER);

    expect(failed.state).toBe('failed');
    expect(failed.failureReason).toBe('the source was unreachable');
    expect(failed.producedEvidenceIds).toEqual([]);
  });

  test('spend totals per recipe, and stays null when any run reported nothing', () => {
    const base = {
      projectId: PROJECT,
      memberId: 'claude',
      sessionId: 'ses_research',
      startedAt: NOW
    };
    const reported = settleRun(
      makeTransformationRun({ ...base, id: 'run_1', transformationId: 'extract-claims' }),
      0,
      { producedEvidenceIds: ['evd_1'], tokens: 1_000, cost: { amount: 0.4, currency: 'USD' } },
      LATER
    );
    const alsoReported = settleRun(
      makeTransformationRun({ ...base, id: 'run_2', transformationId: 'extract-claims' }),
      0,
      { producedEvidenceIds: ['evd_2'], tokens: 500, cost: { amount: 0.2, currency: 'USD' } },
      LATER
    );
    const silent = settleRun(
      makeTransformationRun({ ...base, id: 'run_3', transformationId: 'find-counterexamples' }),
      0,
      { producedEvidenceIds: [] },
      LATER
    );

    const spend = spendByTransformation([reported, alsoReported, silent], BUILT_IN_TRANSFORMATIONS);

    expect(spend).toEqual([
      {
        transformationId: 'extract-claims',
        label: 'Extract claims',
        tier: 'fast',
        runs: 2,
        tokens: 1_500,
        cost: { amount: 0.6000000000000001, currency: 'USD' }
      },
      {
        transformationId: 'find-counterexamples',
        label: 'Find counterexamples',
        tier: 'power',
        runs: 1,
        tokens: null,
        cost: null
      }
    ]);
  });
});

describe('research notes', () => {
  test('a note can be rewritten while it is still scratch paper', () => {
    const note = makeNote({ id: 'note_1', projectId: PROJECT, text: 'this number looks wrong', createdAt: NOW });

    const edited = editNote(note, 0, '  ask legal about clause 7  ', LATER);

    expect(edited.text).toBe('ask legal about clause 7');
    expect(edited.promotedEvidenceId).toBeNull();
  });

  test('promotion is one-way: a promoted note is frozen and cannot be promoted twice', () => {
    const note = makeNote({
      id: 'note_1',
      projectId: PROJECT,
      text: 'competitors moved to usage pricing',
      createdAt: NOW
    });

    const promoted = markNotePromoted(note, 0, 'evd_1', LATER);

    expect(promoted.promotedEvidenceId).toBe('evd_1');
    expect(() => editNote(promoted, 1, 'reworded', LATER)).toThrow('a promoted note is kept as written');
    expect(() => markNotePromoted(promoted, 1, 'evd_2', LATER)).toThrow('this note was already promoted');
  });

  test('an empty note is refused', () => {
    const note = makeNote({ id: 'note_1', projectId: PROJECT, text: 'draft', createdAt: NOW });

    expect(() => editNote(note, 0, '   ', LATER)).toThrow('a note cannot be empty');
  });
});

describe('per-member source visibility', () => {
  test('a project with no rules hands every source to every member', () => {
    const visibility = makeVisibility(PROJECT, NOW);

    expect(readableSources(visibility, 'claude', [source('src_a'), source('src_b')]).map((entry) => entry.id)).toEqual([
      'src_a',
      'src_b'
    ]);
  });

  test('a rule restricts one member without touching the others', () => {
    const restricted = setRule(makeVisibility(PROJECT, NOW), 0, { memberId: 'claude', sourceIds: ['src_a'] }, LATER);

    expect(canRead(restricted, 'claude', 'src_a')).toBe(true);
    expect(canRead(restricted, 'claude', 'src_b')).toBe(false);
    expect(canRead(restricted, 'codex', 'src_b')).toBe(true);
  });

  test('replacing a rule for the same member updates it instead of stacking a second one', () => {
    const first = setRule(makeVisibility(PROJECT, NOW), 0, { memberId: 'claude', sourceIds: ['src_a'] }, LATER);

    const second = setRule(first, 1, { memberId: 'claude', sourceIds: ['src_b'] }, LATER);

    expect(second.rules).toEqual([{ memberId: 'claude', sourceIds: ['src_b'] }]);
    expect(canRead(second, 'claude', 'src_a')).toBe(false);
  });

  test('the matrix reports one cell per member and source', () => {
    const restricted = setRule(makeVisibility(PROJECT, NOW), 0, { memberId: 'codex', sourceIds: [] }, LATER);

    expect(visibilityMatrix(restricted, ['claude', 'codex'], [source('src_a')])).toEqual([
      { memberId: 'claude', sourceId: 'src_a', canRead: true },
      { memberId: 'codex', sourceId: 'src_a', canRead: false }
    ]);
  });

  test('a stale expected version is refused', () => {
    const first = setRule(makeVisibility(PROJECT, NOW), 0, { memberId: 'claude', sourceIds: ['src_a'] }, LATER);

    expect(() => setRule(first, 0, { memberId: 'codex', sourceIds: [] }, LATER)).toThrow(
      'version conflict: expected 0, current 1'
    );
  });
});
