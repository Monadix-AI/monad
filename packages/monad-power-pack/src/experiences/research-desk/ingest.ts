import type { EvidenceClaim, EvidenceContribution, SourceRef } from './domain/index.ts';

import { z } from 'zod';

import { addCitation, attachDerivation, makeEvidenceClaim, makeSourceRef } from './domain/index.ts';
import { researchDeskId } from './store.ts';

const FENCE = /```research-desk\s*([\s\S]*?)```/g;

const sourcePayloadSchema = z.object({
  record: z.literal('source'),
  kind: z.enum(['url', 'file', 'project-artifact']),
  type: z.enum(['primary', 'secondary', 'supplied']).optional(),
  title: z.string().min(1).max(500),
  locator: z.string().min(1).max(4_000),
  fingerprint: z.string().min(1).max(200).optional(),
  status: z.enum(['available', 'blocked', 'failed']).optional(),
  statusReason: z.string().min(1).max(2_000).optional()
});

const claimPayloadSchema = z.object({
  record: z.literal('claim'),
  assignmentId: z.string().min(1).max(200).optional(),
  text: z.string().min(1).max(4_000),
  citations: z
    .array(
      z.object({
        sourceLocator: z.string().min(1).max(4_000),
        excerpt: z.string().min(1).max(4_000),
        locator: z.string().min(1).max(200).optional(),
        stance: z.enum(['support', 'oppose'])
      })
    )
    .max(50)
    .optional(),
  derivation: z
    .object({
      script: z.string().min(1).max(500),
      inputFingerprints: z.array(z.string().min(1).max(200)).min(1).max(50),
      artifactPath: z.string().min(1).max(1_000)
    })
    .optional()
});

const contributionBaseSchema = z.object({
  record: z.literal('claim-contribution'),
  id: z.string().min(1).max(200),
  claimId: z.string().min(1).max(200),
  assignmentId: z.string().min(1).max(200).optional()
});

const contributionPayloadSchema = z.discriminatedUnion('kind', [
  contributionBaseSchema.extend({
    kind: z.literal('citation'),
    payload: z.object({
      sourceLocator: z.string().min(1).max(4_000),
      excerpt: z.string().min(1).max(4_000),
      locator: z.string().min(1).max(200).optional(),
      stance: z.enum(['support', 'oppose'])
    })
  }),
  contributionBaseSchema.extend({
    kind: z.literal('derivation'),
    payload: z.object({
      script: z.string().min(1).max(500),
      inputFingerprints: z.array(z.string().min(1).max(200)).min(1).max(50),
      artifactPath: z.string().min(1).max(1_000)
    })
  }),
  contributionBaseSchema.extend({
    kind: z.literal('challenge'),
    payload: z.object({ reason: z.string().min(1).max(4_000) })
  }),
  contributionBaseSchema.extend({
    kind: z.literal('negative-result'),
    payload: z.object({
      attempt: z.string().min(1).max(4_000),
      outcome: z.string().min(1).max(4_000)
    })
  })
]);

const payloadSchema = z.union([sourcePayloadSchema, claimPayloadSchema, contributionPayloadSchema]);

export type ResearchDeskPayload = z.infer<typeof payloadSchema>;

/** Agents contribute to the three panes by emitting a fenced `research-desk` block, not by calling the
 *  Experience API — the API is the operator's surface and a model that could call it directly would be
 *  able to rule on its own claims. Anything that does not parse is left as ordinary transcript text. */
export function parsePayloads(text: string): ResearchDeskPayload[] {
  const payloads: ResearchDeskPayload[] = [];
  for (const match of text.matchAll(FENCE)) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const parsed = payloadSchema.safeParse(JSON.parse(raw));
      if (parsed.success) payloads.push(parsed.data);
    } catch {
      // A malformed block is transcript noise, not a reason to fail the turn.
    }
  }
  return payloads;
}

export interface IngestContext {
  projectId: string;
  sessionId: string;
  messageId: string;
  memberId: string;
  now: string;
}

export function sourceFromPayload(payload: z.infer<typeof sourcePayloadSchema>, context: IngestContext): SourceRef {
  const base = makeSourceRef({
    id: researchDeskId('src', context.projectId, `${payload.kind}:${payload.locator}`),
    projectId: context.projectId,
    kind: payload.kind,
    type: payload.type,
    title: payload.title,
    locator: payload.locator,
    sessionId: context.sessionId,
    messageId: context.messageId,
    capturedByMemberId: context.memberId,
    createdAt: context.now
  });
  if (payload.status === 'blocked' || payload.status === 'failed') {
    return {
      ...base,
      status: payload.status,
      statusReason: payload.statusReason ?? 'the agent could not read this source'
    };
  }
  if (!payload.fingerprint) return base;
  return { ...base, status: 'available', fingerprint: payload.fingerprint, capturedAt: context.now };
}

export function claimFromPayload(
  payload: z.infer<typeof claimPayloadSchema>,
  context: IngestContext,
  resolveSourceId: (locator: string) => string | null
): EvidenceClaim {
  let claim = makeEvidenceClaim({
    id: researchDeskId('evd', context.projectId, payload.text),
    projectId: context.projectId,
    text: payload.text,
    proposedByMemberId: context.memberId,
    sessionId: context.sessionId,
    messageId: context.messageId,
    createdAt: context.now
  });
  for (const citation of payload.citations ?? []) {
    const sourceId = resolveSourceId(citation.sourceLocator);
    if (!sourceId) continue;
    claim = addCitation(
      claim,
      claim.version,
      {
        sourceId,
        excerpt: citation.excerpt,
        locator: citation.locator ?? null,
        stance: citation.stance,
        addedByMemberId: context.memberId
      },
      context.now
    );
  }
  if (payload.derivation) {
    claim = attachDerivation(
      claim,
      claim.version,
      { ...payload.derivation, ranAt: context.now, ranByMemberId: context.memberId },
      context.now
    );
  }
  return claim;
}

export function contributionFromPayload(
  payload: z.infer<typeof contributionPayloadSchema>,
  context: IngestContext,
  resolveSourceId: (locator: string) => string | null
): EvidenceContribution | null {
  const provenance = {
    id: payload.id,
    claimId: payload.claimId,
    assignmentId: payload.assignmentId ?? null,
    memberId: context.memberId,
    sessionId: context.sessionId,
    messageId: context.messageId,
    createdAt: context.now
  };
  if (payload.kind === 'citation') {
    const sourceId = resolveSourceId(payload.payload.sourceLocator);
    if (!sourceId) return null;
    return {
      ...provenance,
      kind: 'citation',
      payload: {
        sourceId,
        excerpt: payload.payload.excerpt,
        locator: payload.payload.locator ?? null,
        stance: payload.payload.stance
      }
    };
  }
  if (payload.kind === 'derivation') {
    return { ...provenance, kind: 'derivation', payload: payload.payload };
  }
  if (payload.kind === 'challenge') {
    return { ...provenance, kind: 'challenge', payload: payload.payload };
  }
  return { ...provenance, kind: 'negative-result', payload: payload.payload };
}
