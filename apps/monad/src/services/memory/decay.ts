// Temporal confidence decay: a law is trusted less the longer it goes un-reaffirmed. Re-derivation
// (/consolidate bumps updatedAt) resets the clock. Read-time only — no background mutation, so the
// effective confidence is always current. Recall drops laws whose decayed confidence falls below the
// floor; the UI shows the decayed value.

export interface DecaySettings {
  halfLifeDays: number;
  floor: number;
}

const DAY_MS = 86_400_000;

// Gentle default: a 1-year half-life so confidence fades slowly, and floor 0 so nothing is suppressed
// until the user raises it — decay is visible by default but never silently drops a law.
export const DEFAULT_DECAY: DecaySettings = { halfLifeDays: 365, floor: 0 };

/** stored × 0.5^(ageDays / halfLifeDays). halfLifeDays <= 0 disables decay (returns stored). */
export function decayedConfidence(confidence: number, updatedAt: number, now: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return confidence;
  const ageDays = Math.max(0, (now - updatedAt) / DAY_MS);
  return confidence * 0.5 ** (ageDays / halfLifeDays);
}

/** A law is recall-eligible when it isn't contradicted and its decayed confidence clears the floor. */
export function isRecallEligible(
  law: { confidence: number; updatedAt: number; contradictedBy: string | null },
  now: number,
  decay: DecaySettings
): boolean {
  if (law.contradictedBy) return false;
  return decayedConfidence(law.confidence, law.updatedAt, now, decay.halfLifeDays) >= decay.floor;
}
