import type { Citation, EvidenceClaim } from './evidence.ts';

import { z } from 'zod';

import { definedOnly } from './defaults.ts';

/** Two members are sent the same question over the same source and answer without seeing each other.
 *  This is the one thing a single-model notebook cannot do: there, the model that proposes an answer
 *  is also the only thing available to check it. */
const readingSchema = z.object({
  memberId: z.string().min(1),
  provider: z.string().min(1).nullable(),
  sessionId: z.string().min(1),
  answer: z.string().min(1).nullable(),
  citations: z.array(
    z.object({
      sourceId: z.string().min(1),
      excerpt: z.string().min(1),
      locator: z.string().min(1).nullable()
    })
  ),
  state: z.enum(['pending', 'answered', 'failed']),
  failureReason: z.string().min(1).nullable(),
  answeredAt: z.string().min(1).nullable()
});

export type CrossReading = z.infer<typeof readingSchema>;

const crossReadSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  question: z.string().min(1).max(4_000),
  sourceIds: z.array(z.string().min(1)),
  readings: z.array(readingSchema),
  /** Set once a human says whether the readings agree. The system never decides this itself. */
  verdict: z.enum(['agreed', 'disagreed']).nullable(),
  verdictReason: z.string().min(1).nullable(),
  producedEvidenceId: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type CrossRead = z.infer<typeof crossReadSchema>;

export function makeCrossRead(
  input: Pick<CrossRead, 'id' | 'projectId' | 'question' | 'readings'> &
    Partial<Pick<CrossRead, 'sourceIds' | 'createdAt' | 'updatedAt'>>
): CrossRead {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return crossReadSchema.parse({
    schemaVersion: 1,
    sourceIds: [],
    verdict: null,
    verdictReason: null,
    producedEvidenceId: null,
    version: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    ...definedOnly(input)
  });
}

export function normalizeCrossRead(value: unknown): CrossRead {
  return crossReadSchema.parse(value);
}

function assertVersion(crossRead: CrossRead, expectedVersion: number): void {
  if (crossRead.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${crossRead.version}`);
  }
}

export function recordReading(
  crossRead: CrossRead,
  expectedVersion: number,
  input: { memberId: string; answer: string; citations: CrossReading['citations'] },
  now: string
): CrossRead {
  assertVersion(crossRead, expectedVersion);
  const index = crossRead.readings.findIndex((reading) => reading.memberId === input.memberId);
  if (index === -1) throw new Error(`no reading was requested from ${input.memberId}`);
  const current = crossRead.readings[index];
  if (!current) throw new Error(`no reading was requested from ${input.memberId}`);
  const reading = readingSchema.parse({
    ...current,
    answer: input.answer,
    citations: input.citations,
    state: 'answered',
    answeredAt: now
  });
  return {
    ...crossRead,
    readings: crossRead.readings.with(index, reading),
    version: crossRead.version + 1,
    updatedAt: now
  };
}

export function failReading(
  crossRead: CrossRead,
  expectedVersion: number,
  memberId: string,
  reason: string,
  now: string
): CrossRead {
  assertVersion(crossRead, expectedVersion);
  const index = crossRead.readings.findIndex((reading) => reading.memberId === memberId);
  if (index === -1) throw new Error(`no reading was requested from ${memberId}`);
  const current = crossRead.readings[index];
  if (!current) throw new Error(`no reading was requested from ${memberId}`);
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('a failed reading requires a reason');
  return {
    ...crossRead,
    readings: crossRead.readings.with(index, { ...current, state: 'failed', failureReason: trimmed }),
    version: crossRead.version + 1,
    updatedAt: now
  };
}

export function isComplete(crossRead: CrossRead): boolean {
  return crossRead.readings.every((reading) => reading.state !== 'pending');
}

export function answeredReadings(crossRead: CrossRead): CrossReading[] {
  return crossRead.readings.filter((reading) => reading.state === 'answered');
}

export interface CrossReadVerdict {
  verdict: 'agreed' | 'disagreed';
  reason: string;
}

/** The human rules on whether the readings agree.
 *
 *  There is deliberately no automatic comparison here. A similarity score over two prose answers
 *  would be exactly the kind of false precision this product exists to refuse — and getting it wrong
 *  in the "agreed" direction silently destroys the disagreement that was the whole point of asking
 *  twice. Both readings are shown; the person decides. */
export function ruleOnCrossRead(
  crossRead: CrossRead,
  expectedVersion: number,
  verdict: CrossReadVerdict,
  now: string
): CrossRead {
  assertVersion(crossRead, expectedVersion);
  if (!isComplete(crossRead)) throw new Error('every reading must settle before this can be ruled on');
  if (answeredReadings(crossRead).length < 2) {
    throw new Error('ruling on a cross-read needs at least two answered readings');
  }
  const reason = verdict.reason.trim();
  if (!reason) throw new Error('a cross-read verdict requires a reason');
  return {
    ...crossRead,
    verdict: verdict.verdict,
    verdictReason: reason,
    version: crossRead.version + 1,
    updatedAt: now
  };
}

/** Turn a ruled cross-read into one claim carrying both sides.
 *
 *  Agreement produces a claim supported by every reader's citations. Disagreement produces the same
 *  claim with the dissenting reader's material attached as `oppose`, which lands it in the pool as
 *  `contested` — so a split between two vendors becomes a decision waiting for a person, never an
 *  averaged answer that hides that the split happened. */
export function claimFromCrossRead(
  crossRead: CrossRead,
  input: { id: string; text: string; proposedByMemberId: string; sessionId: string }
): {
  text: EvidenceClaim['text'];
  citations: Omit<Citation, 'addedAt'>[];
  id: string;
  sessionId: string;
  proposedByMemberId: string;
} {
  if (!crossRead.verdict) throw new Error('an unruled cross-read does not produce a claim');
  const readings = answeredReadings(crossRead);
  const [first, ...rest] = readings;
  if (!first) throw new Error('an unanswered cross-read does not produce a claim');
  const dissenting = crossRead.verdict === 'disagreed' ? rest : [];
  const agreeing = crossRead.verdict === 'disagreed' ? [first] : readings;
  const citations = [
    ...agreeing.flatMap((reading) =>
      reading.citations.map((citation) => ({
        sourceId: citation.sourceId,
        excerpt: citation.excerpt,
        locator: citation.locator,
        stance: 'support' as const,
        addedByMemberId: reading.memberId
      }))
    ),
    ...dissenting.flatMap((reading) =>
      reading.citations.map((citation) => ({
        sourceId: citation.sourceId,
        excerpt: citation.excerpt,
        locator: citation.locator,
        stance: 'oppose' as const,
        addedByMemberId: reading.memberId
      }))
    )
  ];
  return {
    id: input.id,
    text: input.text,
    proposedByMemberId: input.proposedByMemberId,
    sessionId: input.sessionId,
    citations
  };
}

export function markClaimProduced(
  crossRead: CrossRead,
  expectedVersion: number,
  evidenceId: string,
  now: string
): CrossRead {
  assertVersion(crossRead, expectedVersion);
  return { ...crossRead, producedEvidenceId: evidenceId, version: crossRead.version + 1, updatedAt: now };
}
