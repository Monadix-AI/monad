import { z } from 'zod';

import { definedOnly } from './defaults.ts';

export const TRANSFORMATION_ROLES = ['researcher', 'evidence-engineer'] as const;
export const TRANSFORMATION_TIERS = ['fast', 'smart', 'power'] as const;
export const TRANSFORMATION_OUTPUTS = ['claim', 'counterclaim', 'derivation', 'summary'] as const;

const roleSchema = z.enum(TRANSFORMATION_ROLES);
const tierSchema = z.enum(TRANSFORMATION_TIERS);
const outputSchema = z.enum(TRANSFORMATION_OUTPUTS);

export type TransformationRole = z.infer<typeof roleSchema>;
export type TransformationTier = z.infer<typeof tierSchema>;
export type TransformationOutput = z.infer<typeof outputSchema>;

/** A named extraction recipe. The point of binding a role and a tier to each one is that the work is
 *  not uniform: pulling quotes out of a page is mechanical, finding the counterexample that kills a
 *  claim is the hardest reasoning in the room. A team runtime can price those differently because
 *  each member has its own identity and its own ledger line. */
const transformationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(120),
  role: roleSchema,
  tier: tierSchema,
  output: outputSchema,
  instruction: z.string().min(1).max(8_000),
  builtIn: z.boolean()
});

export type Transformation = z.infer<typeof transformationSchema>;

const runSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  transformationId: z.string().min(1),
  sourceId: z.string().min(1).nullable(),
  memberId: z.string().min(1),
  sessionId: z.string().min(1),
  state: z.enum(['running', 'settled', 'failed']),
  producedEvidenceIds: z.array(z.string().min(1)),
  /** Only what the provider actually reported. A run whose provider reports nothing stays null here
   *  rather than contributing a zero that would read as "this step was free". */
  tokens: z.number().int().nonnegative().nullable(),
  cost: z.object({ amount: z.number(), currency: z.string().min(1) }).nullable(),
  failureReason: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  startedAt: z.string().min(1),
  settledAt: z.string().min(1).nullable()
});

export type TransformationRun = z.infer<typeof runSchema>;

/** The starting recipe set. `find-counterexamples` deliberately runs on the priciest tier and
 *  `extract-claims` on the cheapest — that spread is the visible argument for a team runtime, so it
 *  is the default rather than something an operator has to discover. */
export const BUILT_IN_TRANSFORMATIONS: readonly Transformation[] = [
  {
    schemaVersion: 1,
    id: 'extract-claims',
    label: 'Extract claims',
    role: 'researcher',
    tier: 'fast',
    output: 'claim',
    instruction:
      'Read the source and emit each falsifiable claim it supports, with an exact excerpt and locator for every one.',
    builtIn: true
  },
  {
    schemaVersion: 1,
    id: 'find-counterexamples',
    label: 'Find counterexamples',
    role: 'evidence-engineer',
    tier: 'power',
    output: 'counterclaim',
    instruction:
      'Try to refute the claims already in the pool. Report material that contradicts them, and say which claim each piece opposes.',
    builtIn: true
  },
  {
    schemaVersion: 1,
    id: 'recompute-numbers',
    label: 'Recompute the numbers',
    role: 'evidence-engineer',
    tier: 'smart',
    output: 'derivation',
    instruction:
      'Recompute every figure a claim depends on from the supplied data. Report the script, the fingerprint of each input, and the output artifact.',
    builtIn: true
  }
];

export function makeTransformation(
  input: Pick<Transformation, 'id' | 'label' | 'role' | 'output' | 'instruction'> &
    Partial<Pick<Transformation, 'tier' | 'builtIn'>>
): Transformation {
  return transformationSchema.parse({ schemaVersion: 1, tier: 'smart', builtIn: false, ...definedOnly(input) });
}

export function normalizeTransformation(value: unknown): Transformation {
  return transformationSchema.parse(value);
}

export function normalizeTransformationRun(value: unknown): TransformationRun {
  return runSchema.parse(value);
}

export function makeTransformationRun(
  input: Pick<TransformationRun, 'id' | 'projectId' | 'transformationId' | 'memberId' | 'sessionId' | 'startedAt'> &
    Partial<Pick<TransformationRun, 'sourceId' | 'version'>>
): TransformationRun {
  return runSchema.parse({
    schemaVersion: 1,
    sourceId: null,
    state: 'running',
    producedEvidenceIds: [],
    tokens: null,
    cost: null,
    failureReason: null,
    version: 0,
    settledAt: null,
    ...definedOnly(input)
  });
}

function assertVersion(run: TransformationRun, expectedVersion: number): void {
  if (run.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${run.version}`);
  }
}

export function settleRun(
  run: TransformationRun,
  expectedVersion: number,
  input: { producedEvidenceIds: string[]; tokens?: number; cost?: { amount: number; currency: string } },
  now: string
): TransformationRun {
  assertVersion(run, expectedVersion);
  return {
    ...run,
    state: 'settled',
    producedEvidenceIds: input.producedEvidenceIds,
    tokens: input.tokens ?? null,
    cost: input.cost ?? null,
    version: run.version + 1,
    settledAt: now
  };
}

export function failRun(
  run: TransformationRun,
  expectedVersion: number,
  reason: string,
  now: string
): TransformationRun {
  assertVersion(run, expectedVersion);
  const trimmed = reason.trim();
  if (!trimmed) throw new Error('a failed run requires a reason');
  return { ...run, state: 'failed', failureReason: trimmed, version: run.version + 1, settledAt: now };
}

export interface TransformationSpend {
  transformationId: string;
  label: string;
  tier: TransformationTier;
  runs: number;
  tokens: number | null;
  cost: { amount: number; currency: string } | null;
}

/** Per-recipe spend for the report footer. Providers that reported nothing keep the total at `null`
 *  instead of pulling it down to a partial sum that looks authoritative. */
export function spendByTransformation(
  runs: readonly TransformationRun[],
  transformations: readonly Transformation[]
): TransformationSpend[] {
  return transformations
    .map((transformation) => {
      const own = runs.filter((run) => run.transformationId === transformation.id && run.state === 'settled');
      const reportedTokens = own.filter((run) => run.tokens !== null);
      const reportedCost = own.filter((run) => run.cost !== null);
      const currency = reportedCost[0]?.cost?.currency;
      return {
        transformationId: transformation.id,
        label: transformation.label,
        tier: transformation.tier,
        runs: own.length,
        tokens:
          reportedTokens.length === own.length && own.length > 0
            ? reportedTokens.reduce((total, run) => total + (run.tokens ?? 0), 0)
            : null,
        cost:
          currency && reportedCost.length === own.length && own.length > 0
            ? {
                amount: reportedCost.reduce((total, run) => total + (run.cost?.amount ?? 0), 0),
                currency
              }
            : null
      };
    })
    .filter((spend) => spend.runs > 0);
}
