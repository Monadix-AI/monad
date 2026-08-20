import type { SourceRef } from './source.ts';

import { z } from 'zod';

/**
 * Which member may be handed which source's content.
 *
 * SCOPE — read before relying on this for anything: this is an application-level filter over what
 * Research Desk itself sends into a member's session. It is NOT network isolation. Nothing here stops
 * an agent from fetching the same URL on its own; per-member egress capability does not exist in the
 * runtime today. Describe it as "control what each member reads", never as "isolate a member from the
 * network", and do not reuse it as a security boundary.
 */
const ruleSchema = z.object({
  memberId: z.string().min(1),
  /** Sources this member may read. `null` means every source — the default, so a project that never
   *  opens the matrix behaves exactly as before. */
  sourceIds: z.array(z.string().min(1)).nullable()
});

const visibilitySchema = z.object({
  schemaVersion: z.literal(1),
  projectId: z.string().min(1),
  rules: z.array(ruleSchema),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().min(1)
});

export type VisibilityRule = z.infer<typeof ruleSchema>;
export type SourceVisibility = z.infer<typeof visibilitySchema>;

export function makeVisibility(projectId: string, now: string): SourceVisibility {
  return visibilitySchema.parse({ schemaVersion: 1, projectId, rules: [], version: 0, updatedAt: now });
}

export function normalizeVisibility(value: unknown): SourceVisibility {
  return visibilitySchema.parse(value);
}

export function canRead(visibility: SourceVisibility, memberId: string, sourceId: string): boolean {
  const rule = visibility.rules.find((entry) => entry.memberId === memberId);
  if (!rule || rule.sourceIds === null) return true;
  return rule.sourceIds.includes(sourceId);
}

export function readableSources(
  visibility: SourceVisibility,
  memberId: string,
  sources: readonly SourceRef[]
): SourceRef[] {
  return sources.filter((source) => canRead(visibility, memberId, source.id));
}

export function setRule(
  visibility: SourceVisibility,
  expectedVersion: number,
  rule: VisibilityRule,
  now: string
): SourceVisibility {
  if (visibility.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${visibility.version}`);
  }
  const parsed = ruleSchema.parse(rule);
  const index = visibility.rules.findIndex((entry) => entry.memberId === parsed.memberId);
  const rules = index === -1 ? [...visibility.rules, parsed] : visibility.rules.with(index, parsed);
  return { ...visibility, rules, version: visibility.version + 1, updatedAt: now };
}

export interface VisibilityCell {
  memberId: string;
  sourceId: string;
  canRead: boolean;
}

export function visibilityMatrix(
  visibility: SourceVisibility,
  memberIds: readonly string[],
  sources: readonly SourceRef[]
): VisibilityCell[] {
  return memberIds.flatMap((memberId) =>
    sources.map((source) => ({ memberId, sourceId: source.id, canRead: canRead(visibility, memberId, source.id) }))
  );
}
