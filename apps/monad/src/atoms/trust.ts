// Which atom packs may contribute a workplace experience. An experience runs in-process inside the
// Web host and drives project state through the host action surface, so — unlike a channel or a
// provider — "installed" is not enough. The pack must also carry evidence that the user accepted it
// for this kind and that the bundle on disk is the one they accepted, and it must satisfy whatever
// review policy the operator configured.
//
// Trust is DERIVED at load time from the install record, never stored as a flag: a stored
// `trusted: true` in `.install.json` would be a self-service privilege escalation for anything that
// can write inside the pack dir.

import type { MonadConfig } from '@monad/environment';
import type { AtomPackInstallRecord } from '#/atoms/install/index.ts';

export type AtomPackExperienceReview = MonadConfig['atomExperienceReview'];

export interface AtomPackTrustInput {
  /** The pack's stable identity — its install-dir name, the same id the operator names in policy. */
  atomPackId: string;
  /** Parsed `.install.json`, or undefined for a drop-in pack that was never installed through the CLI. */
  record?: AtomPackInstallRecord;
  /** Operator review policy. Absent → evidence alone decides. */
  review?: AtomPackExperienceReview;
}

export interface AtomPackTrustDecision {
  trusted: boolean;
  /** Why trust was refused, in the order checked. Empty when trusted. */
  reasons: string[];
}

/** What the install record proves on its own, before the operator's policy is applied. */
function evidenceReasons(record?: AtomPackInstallRecord): string[] {
  if (!record) return ['no install record — drop-in packs are not accepted for this kind'];

  const reasons: string[] = [];
  if (!record.grantedAtoms?.includes('workplace-experience')) {
    reasons.push('the recorded install consent does not cover the "workplace-experience" atom kind');
  }
  switch (record.sourceKind) {
    case 'local':
      break;
    case 'github':
    case 'npm':
      if (!record.integrity) reasons.push('installed from a remote source with no recorded integrity hash');
      break;
    case undefined:
      reasons.push('install record predates source tracking — reinstall to record an accepted source');
      break;
    default:
      reasons.push(`unrecognized install source kind "${record.sourceKind}"`);
  }
  return reasons;
}

/**
 * Decide whether a pack may register `workplace-experience` atoms.
 *
 * Evidence first: a local install is accepted on the operator's own say-so (they pointed the
 * installer at a path on this machine and confirmed the consent prompt), while a remote install also
 * needs a recorded integrity hash — that hash is what pins the bundle to the artifact they consented
 * to, and discovery re-verifies it on every load, so a later upstream swap cannot take effect. A
 * mutable ref is therefore not disqualifying on its own; an unpinned bundle is.
 *
 * The operator's review policy then overrides in both directions. `deny` always wins. Listing a pack
 * in `allow` admits it even when the evidence is short — that is the point of a human review, and it
 * is why `allow` is an explicit, per-pack decision rather than a blanket switch.
 */
export function resolveAtomPackExperienceTrust(input: AtomPackTrustInput): AtomPackTrustDecision {
  const review = input.review;

  if (review?.deny.includes(input.atomPackId)) {
    return { trusted: false, reasons: ['denied by the operator review policy'] };
  }
  if (review?.allow.includes(input.atomPackId)) return { trusted: true, reasons: [] };
  if (review?.policy === 'allowlist') {
    return {
      trusted: false,
      reasons: ['the operator review policy admits only packs on its allow list']
    };
  }

  const reasons = evidenceReasons(input.record);
  return { trusted: reasons.length === 0, reasons };
}
