import { z } from 'zod';

import { definedOnly } from './defaults.ts';

export const EVIDENCE_STATUSES = ['unverified', 'supported', 'contested', 'rejected', 'accepted'] as const;
export const CITATION_STANCES = ['support', 'oppose'] as const;

const evidenceStatusSchema = z.enum(EVIDENCE_STATUSES);
const citationStanceSchema = z.enum(CITATION_STANCES);

export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>;
export type CitationStance = z.infer<typeof citationStanceSchema>;

const citationSchema = z.object({
  sourceId: z.string().min(1),
  excerpt: z.string().min(1),
  locator: z.string().min(1).nullable(),
  stance: citationStanceSchema,
  addedByMemberId: z.string().min(1),
  addedAt: z.string().min(1)
});

/** What makes a derived claim reproducible: the script, the fingerprints of every input it read, and
 *  the artifact it produced. Re-running with the same three must yield the same output — that is the
 *  whole point of recording them, so none of them is optional. */
const derivationSchema = z.object({
  script: z.string().min(1),
  inputFingerprints: z.array(z.string().min(1)).min(1),
  artifactPath: z.string().min(1),
  ranAt: z.string().min(1),
  ranByMemberId: z.string().min(1)
});

export type EvidenceDerivation = z.infer<typeof derivationSchema>;

const contributionCitationSchema = z.object({
  sourceId: z.string().min(1),
  excerpt: z.string().min(1),
  locator: z.string().min(1).nullable(),
  stance: citationStanceSchema
});

const contributionDerivationSchema = z.object({
  script: z.string().min(1),
  inputFingerprints: z.array(z.string().min(1)).min(1),
  artifactPath: z.string().min(1)
});

const evidenceContributionBaseSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  assignmentId: z.string().min(1).nullable(),
  memberId: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  createdAt: z.string().min(1)
});

export const evidenceContributionSchema = z.discriminatedUnion('kind', [
  evidenceContributionBaseSchema.extend({ kind: z.literal('citation'), payload: contributionCitationSchema }),
  evidenceContributionBaseSchema.extend({ kind: z.literal('derivation'), payload: contributionDerivationSchema }),
  evidenceContributionBaseSchema.extend({
    kind: z.literal('challenge'),
    payload: z.object({ reason: z.string().min(1) })
  }),
  evidenceContributionBaseSchema.extend({
    kind: z.literal('negative-result'),
    payload: z.object({ attempt: z.string().min(1), outcome: z.string().min(1) })
  })
]);

export type EvidenceContribution = z.infer<typeof evidenceContributionSchema>;

const evidenceClaimSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  text: z.string().min(1),
  status: evidenceStatusSchema,
  citations: z.array(citationSchema),
  derivations: z.array(derivationSchema),
  contributions: z.array(evidenceContributionSchema).default([]),
  proposedByMemberId: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1).nullable(),
  decidedBy: z.literal('human').nullable(),
  decisionReason: z.string().min(1).nullable(),
  decidedAt: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;
export type Citation = z.infer<typeof citationSchema>;

export function makeEvidenceClaim(
  input: Pick<EvidenceClaim, 'id' | 'projectId' | 'text' | 'proposedByMemberId' | 'sessionId'> &
    Partial<Omit<EvidenceClaim, 'schemaVersion' | 'id' | 'projectId' | 'text' | 'proposedByMemberId' | 'sessionId'>>
): EvidenceClaim {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return evidenceClaimSchema.parse({
    schemaVersion: 1,
    status: 'unverified',
    citations: [],
    derivations: [],
    contributions: [],
    messageId: null,
    decidedBy: null,
    decisionReason: null,
    decidedAt: null,
    version: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    ...definedOnly(input)
  });
}

export function normalizeEvidenceClaim(value: unknown): EvidenceClaim {
  return evidenceClaimSchema.parse(value);
}

export function makeEvidenceContribution(input: EvidenceContribution): EvidenceContribution {
  return evidenceContributionSchema.parse(input);
}

function assertVersion(claim: EvidenceClaim, expectedVersion: number): void {
  if (claim.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${claim.version}`);
  }
}

function isDecided(claim: EvidenceClaim): boolean {
  return claim.status === 'accepted' || claim.status === 'rejected';
}

/** Machine-readable reading of the material alone: nothing cited is unverified, one-sided material is
 *  supported, material pointing both ways is contested. It never produces `accepted`/`rejected` —
 *  those are the human's, and this function is what a decision overrides. */
export function statusFromCitations(citations: readonly Citation[]): EvidenceStatus {
  if (citations.some((citation) => citation.stance === 'oppose')) return 'contested';
  if (citations.some((citation) => citation.stance === 'support')) return 'supported';
  return 'unverified';
}

function statusFromMaterial(
  citations: readonly Citation[],
  contributions: readonly EvidenceContribution[],
  derivations: readonly EvidenceDerivation[]
): EvidenceStatus {
  if (contributions.some((contribution) => contribution.kind === 'challenge')) return 'contested';
  const citationStatus = statusFromCitations(citations);
  if (citationStatus !== 'unverified') return citationStatus;
  if (derivations.length > 0) return 'supported';
  return 'unverified';
}

export function applyEvidenceContribution(
  claim: EvidenceClaim,
  expectedVersion: number,
  contribution: EvidenceContribution,
  now: string
): EvidenceClaim {
  assertVersion(claim, expectedVersion);
  const parsed = evidenceContributionSchema.parse(contribution);
  if (parsed.claimId !== claim.id) throw new Error(`contribution targets another claim: ${parsed.claimId}`);
  if (claim.contributions.some((entry) => entry.id === parsed.id)) return claim;

  const citations = [...claim.citations];
  const derivations = [...claim.derivations];
  if (parsed.kind === 'citation') {
    citations.push(
      citationSchema.parse({
        ...parsed.payload,
        addedByMemberId: parsed.memberId,
        addedAt: parsed.createdAt
      })
    );
  } else if (parsed.kind === 'derivation') {
    derivations.push(
      derivationSchema.parse({
        ...parsed.payload,
        ranByMemberId: parsed.memberId,
        ranAt: parsed.createdAt
      })
    );
  }
  const contributions = [...claim.contributions, parsed];
  return {
    ...claim,
    citations,
    derivations,
    contributions,
    status: isDecided(claim) ? claim.status : statusFromMaterial(citations, contributions, derivations),
    version: claim.version + 1,
    updatedAt: now
  };
}

export function addCitation(
  claim: EvidenceClaim,
  expectedVersion: number,
  citation: Omit<Citation, 'addedAt'>,
  now: string
): EvidenceClaim {
  assertVersion(claim, expectedVersion);
  const citations = [...claim.citations, citationSchema.parse({ ...citation, addedAt: now })];
  return {
    ...claim,
    citations,
    // A human decision is not silently reopened by newly arriving material; the decision record stays
    // and the operator sees the new citation against it.
    status: isDecided(claim) ? claim.status : statusFromMaterial(citations, claim.contributions, claim.derivations),
    version: claim.version + 1,
    updatedAt: now
  };
}

export function attachDerivation(
  claim: EvidenceClaim,
  expectedVersion: number,
  derivation: EvidenceDerivation,
  now: string
): EvidenceClaim {
  assertVersion(claim, expectedVersion);
  const derivations = [...claim.derivations, derivationSchema.parse(derivation)];
  return {
    ...claim,
    derivations,
    status: isDecided(claim) ? claim.status : statusFromMaterial(claim.citations, claim.contributions, derivations),
    version: claim.version + 1,
    updatedAt: now
  };
}

export interface ClaimDecision {
  status: Extract<EvidenceStatus, 'accepted' | 'rejected'>;
  reason: string;
  editedText?: string;
}

/** The human's ruling. A reason is mandatory — the transcript of *why* a contested claim was accepted
 *  is the part a reader of the published report can actually challenge — and accepting with a narrowed
 *  wording is a first-class outcome, not an edit plus a separate approval. */
export function decideClaim(
  claim: EvidenceClaim,
  expectedVersion: number,
  decision: ClaimDecision,
  now: string
): EvidenceClaim {
  assertVersion(claim, expectedVersion);
  const reason = decision.reason.trim();
  if (!reason) throw new Error('a decision requires a reason');
  const text = decision.editedText?.trim();
  if (decision.editedText !== undefined && !text) throw new Error('an edited claim cannot be empty');
  return {
    ...claim,
    text: text ?? claim.text,
    status: decision.status,
    decidedBy: 'human',
    decisionReason: reason,
    decidedAt: now,
    version: claim.version + 1,
    updatedAt: now
  };
}

/** Reopening a decided claim returns it to what the material says, and clears the decision record with
 *  it — a stale "you accepted this" line under material that has since changed is worse than none. */
export function reopenClaim(claim: EvidenceClaim, expectedVersion: number, now: string): EvidenceClaim {
  assertVersion(claim, expectedVersion);
  if (!isDecided(claim)) return claim;
  return {
    ...claim,
    status: statusFromMaterial(claim.citations, claim.contributions, claim.derivations),
    decidedBy: null,
    decisionReason: null,
    decidedAt: null,
    version: claim.version + 1,
    updatedAt: now
  };
}

export function isCitableInReport(claim: EvidenceClaim): boolean {
  return claim.status === 'accepted';
}
