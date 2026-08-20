import type { ClaimDecision, EvidenceClaim, SourceRef } from '../domain/index.ts';

import { useEffect, useState } from 'react';

import { decisionBody, evidenceStatusTone, shortFingerprint } from '../client-logic.ts';
import { StatusChip } from './status-chip.tsx';

export function EvidencePane({
  claims,
  focused,
  onChallenge,
  onDecide,
  onOpenCrossRead,
  onOpenNotes,
  onRerun,
  onSelect,
  pendingClaimIds,
  selectedClaim,
  sourcesById
}: {
  claims: readonly EvidenceClaim[];
  focused: boolean;
  onChallenge(claim: EvidenceClaim): Promise<void>;
  onDecide(claim: EvidenceClaim, decision: ClaimDecision): Promise<void>;
  onOpenCrossRead?(): void;
  onOpenNotes?(): void;
  onRerun(claim: EvidenceClaim): Promise<void>;
  onSelect(claimId: string): void;
  pendingClaimIds: ReadonlySet<string>;
  selectedClaim: EvidenceClaim | null;
  sourcesById: ReadonlyMap<string, SourceRef>;
}) {
  return (
    <section
      aria-label="Evidence"
      className="pane evidence-pane"
      data-focused={focused}
    >
      <header className="pane-header">
        <h2 className="pane-heading">
          Evidence <small>{claims.length} claims</small>
        </h2>
        <div className="pane-header-actions">
          <span className="pane-meta">{claims.filter((claim) => claim.status === 'contested').length} need you</span>
          {onOpenCrossRead ? (
            <button
              className="pane-add"
              onClick={onOpenCrossRead}
              type="button"
            >
              Cross-read
            </button>
          ) : null}
          {onOpenNotes ? (
            <button
              className="pane-add"
              onClick={onOpenNotes}
              type="button"
            >
              Notes
            </button>
          ) : null}
        </div>
      </header>
      <div className="pane-body">
        {claims.length ? (
          claims.map((claim) => {
            const selected = claim.id === selectedClaim?.id;
            return (
              <div
                className="evidence-sections"
                key={claim.id}
              >
                <button
                  aria-expanded={selected}
                  className={selected ? 'evidence-card linked selectable-card' : 'evidence-card selectable-card'}
                  onClick={() => onSelect(claim.id)}
                  type="button"
                >
                  <span className="card-row">
                    <span className="card-title">{claim.text}</span>
                    <StatusChip
                      label={claim.status}
                      tone={evidenceStatusTone(claim.status)}
                    />
                  </span>
                  <span className="metadata source-detail">proposed by {claim.proposedByMemberId}</span>
                </button>
                {selected ? (
                  <EvidenceDetails
                    claim={claim}
                    onChallenge={onChallenge}
                    onDecide={onDecide}
                    onRerun={onRerun}
                    pending={pendingClaimIds.has(claim.id)}
                    sourcesById={sourcesById}
                  />
                ) : null}
              </div>
            );
          })
        ) : (
          <div className="empty-state">
            <span className="empty-direction">
              Sources <span>→</span> Evidence <span>→</span> Report
            </span>
            <h3>Evidence appears as sources are read</h3>
            <p>
              The first claim can be unverified. It becomes useful when support, opposition, and derivations stay
              visible.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

function EvidenceDetails({
  claim,
  onChallenge,
  onDecide,
  onRerun,
  pending,
  sourcesById
}: {
  claim: EvidenceClaim;
  onChallenge(claim: EvidenceClaim): Promise<void>;
  onDecide(claim: EvidenceClaim, decision: ClaimDecision): Promise<void>;
  onRerun(claim: EvidenceClaim): Promise<void>;
  pending: boolean;
  sourcesById: ReadonlyMap<string, SourceRef>;
}) {
  const [editedText, setEditedText] = useState(claim.text);
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState('');
  const support = claim.citations.filter((citation) => citation.stance === 'support');
  const oppose = claim.citations.filter((citation) => citation.stance === 'oppose');

  useEffect(() => {
    setEditedText(claim.text);
    setReason('');
    setFieldError('');
  }, [claim.text]);

  const decide = async (status: ClaimDecision['status']) => {
    try {
      const decision = decisionBody(status, reason, editedText, claim.text);
      setFieldError('');
      await onDecide(claim, decision);
    } catch (cause) {
      setFieldError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <>
      <p className="section-label">Supporting · {support.length}</p>
      {support.map((citation) => (
        <article
          className="evidence-card"
          key={`${citation.sourceId}:${citation.addedAt}`}
        >
          <div className="citation-excerpt">“{citation.excerpt}”</div>
          <div className="metadata source-detail">
            {sourcesById.get(citation.sourceId)?.title ?? citation.sourceId}
            {citation.locator ? ` · ${citation.locator}` : ''}
          </div>
        </article>
      ))}
      <p className="section-label">Opposing · {oppose.length}</p>
      {oppose.map((citation) => (
        <article
          className="evidence-card"
          key={`${citation.sourceId}:${citation.addedAt}`}
        >
          <div className="opposition-summary">{citation.excerpt}</div>
          <div className="metadata source-detail">
            {sourcesById.get(citation.sourceId)?.title ?? citation.sourceId}
            {citation.locator ? ` · ${citation.locator}` : ''}
          </div>
        </article>
      ))}
      {claim.derivations.map((derivation) => (
        <article
          className="evidence-card"
          key={`${derivation.script}:${derivation.ranAt}`}
        >
          <div className="card-row">
            <div>
              <h3 className="card-title">Reproducible verification</h3>
              <p className="metadata source-detail">ran by {derivation.ranByMemberId}</p>
            </div>
            <button
              className="rerun-button"
              disabled={pending}
              onClick={() => void onRerun(claim)}
              type="button"
            >
              Re-run
            </button>
          </div>
          <dl className="derivation derivation-data">
            <dt>script</dt>
            <dd>{derivation.script}</dd>
            <dt>inputs</dt>
            <dd>{derivation.inputFingerprints.map(shortFingerprint).join(' · ')}</dd>
            <dt>output</dt>
            <dd>{derivation.artifactPath}</dd>
          </dl>
        </article>
      ))}
      {claim.status === 'contested' || claim.status === 'supported' || claim.status === 'unverified' ? (
        <form
          className="decision-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void decide('accepted');
          }}
        >
          <h3>Your decision</h3>
          <p className="decision-copy">Accepting or rejecting a claim requires a reason.</p>
          <label>
            <span className="sr-only">Edited claim</span>
            <textarea
              aria-label="Edited claim"
              className="diff-editor"
              disabled={pending}
              onChange={(event) => setEditedText(event.currentTarget.value)}
              value={editedText}
            />
          </label>
          <label>
            <span className="sr-only">Decision reason</span>
            <textarea
              aria-describedby={fieldError ? `decision-error-${claim.id}` : undefined}
              aria-label="Decision reason"
              className="reason-input"
              disabled={pending}
              onChange={(event) => setReason(event.currentTarget.value)}
              placeholder="Why does this decision hold?"
              required
              value={reason}
            />
          </label>
          {fieldError ? (
            <p
              className="field-error"
              id={`decision-error-${claim.id}`}
              role="alert"
            >
              {fieldError}
            </p>
          ) : null}
          <div className="decision-actions">
            <button
              disabled={pending}
              onClick={() => void onChallenge(claim)}
              type="button"
            >
              Challenge with Evidence Engineer
            </button>
            <button
              className="primary"
              disabled={pending}
              type="submit"
            >
              Accept edited claim
            </button>
            <button
              disabled={pending}
              onClick={() => void decide('rejected')}
              type="button"
            >
              Reject
            </button>
          </div>
        </form>
      ) : (
        <div className="decision-panel">
          <h3>Human decision</h3>
          <p className="decision-copy">{claim.decisionReason ?? 'No decision reason was recorded.'}</p>
        </div>
      )}
    </>
  );
}
