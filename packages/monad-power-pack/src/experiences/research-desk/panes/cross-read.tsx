import type { ResearchMemberSummary } from '../client-logic.ts';
import type { CrossRead, CrossReadVerdict, SourceRef } from '../domain/index.ts';

import { useState } from 'react';

import { crossReadCanBeRuled } from '../client-logic.ts';

export function CrossReadPanel({
  crossReads,
  members,
  memberNamesById = new Map(),
  onClose,
  onRule,
  onStart,
  pendingCrossReadIds,
  sources,
  starting
}: {
  crossReads: readonly CrossRead[];
  members: readonly ResearchMemberSummary[];
  memberNamesById?: ReadonlyMap<string, string>;
  onClose(): void;
  onRule(crossRead: CrossRead, verdict: CrossReadVerdict, claimText: string): Promise<void>;
  onStart(input: { question: string; sourceIds: string[]; memberIds: string[] }): Promise<void>;
  pendingCrossReadIds: ReadonlySet<string>;
  sources: readonly SourceRef[];
  starting: boolean;
}) {
  const [question, setQuestion] = useState('');
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const eligibleMembers = members.filter((member) => member.role !== 'other');
  const [memberIds, setMemberIds] = useState(() => eligibleMembers.slice(0, 2).map((member) => member.memberId));
  const [error, setError] = useState('');
  const sourcesById = new Map(sources.map((source) => [source.id, source]));

  return (
    <aside
      aria-label="Cross-read"
      className="mesh-drawer cross-read-panel"
    >
      <header className="mesh-drawer-header">
        <div>
          <h2>Cross-read</h2>
          <p>Independent members read the same material. You decide whether their answers agree.</p>
        </div>
        <button
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </header>
      <form
        className="cross-read-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!question.trim()) {
            setError('Ask a specific question.');
            return;
          }
          if (!sourceIds.length) {
            setError('Choose at least one source.');
            return;
          }
          if (memberIds.length < 2) {
            setError('Choose at least two distinct readers.');
            return;
          }
          try {
            await onStart({ question: question.trim(), sourceIds, memberIds });
            setQuestion('');
            setSourceIds([]);
            setError('');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          }
        }}
      >
        <label>
          <span>Question for both readers</span>
          <textarea
            disabled={starting}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            placeholder="What should two independent readers verify?"
            value={question}
          />
        </label>
        <fieldset>
          <legend>Sources</legend>
          <div className="cross-read-sources">
            {sources.map((source) => (
              <label key={source.id}>
                <input
                  checked={sourceIds.includes(source.id)}
                  disabled={starting}
                  onChange={(event) =>
                    setSourceIds((current) =>
                      event.currentTarget.checked
                        ? [...current, source.id]
                        : current.filter((sourceId) => sourceId !== source.id)
                    )
                  }
                  type="checkbox"
                />
                <span>{source.title}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>Independent readers</legend>
          <div className="cross-read-sources">
            {eligibleMembers.map((member) => (
              <label key={member.memberId}>
                <input
                  checked={memberIds.includes(member.memberId)}
                  disabled={starting || (!memberIds.includes(member.memberId) && memberIds.length >= 4)}
                  onChange={(event) =>
                    setMemberIds((current) =>
                      event.currentTarget.checked
                        ? [...current, member.memberId]
                        : current.filter((memberId) => memberId !== member.memberId)
                    )
                  }
                  type="checkbox"
                />
                <span>{member.displayName}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mesh-form-actions">
          <span
            className="field-error"
            role={error ? 'alert' : undefined}
          >
            {error}
          </span>
          <button
            className="primary"
            disabled={starting || !sources.length || eligibleMembers.length < 2}
            type="submit"
          >
            {starting ? 'Dispatching…' : 'Ask readers'}
          </button>
        </div>
      </form>
      <div className="cross-read-list">
        {crossReads.length ? (
          crossReads.toReversed().map((crossRead) => (
            <CrossReadCard
              crossRead={crossRead}
              key={crossRead.id}
              memberNamesById={memberNamesById}
              onRule={onRule}
              pending={pendingCrossReadIds.has(crossRead.id)}
              sourcesById={sourcesById}
            />
          ))
        ) : (
          <div className="mesh-empty-state">
            <h3>No cross-reads yet</h3>
            <p>Ask one question of the same sources to compare two independent answers.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function CrossReadCard({
  crossRead,
  memberNamesById,
  onRule,
  pending,
  sourcesById
}: {
  crossRead: CrossRead;
  memberNamesById: ReadonlyMap<string, string>;
  onRule(crossRead: CrossRead, verdict: CrossReadVerdict, claimText: string): Promise<void>;
  pending: boolean;
  sourcesById: ReadonlyMap<string, SourceRef>;
}) {
  const [reason, setReason] = useState('');
  const [claimText, setClaimText] = useState(
    crossRead.readings.find((reading) => reading.state === 'answered')?.answer ?? crossRead.question
  );
  const [error, setError] = useState('');
  const settled = crossRead.readings.every((reading) => reading.state !== 'pending');
  const canRule = crossReadCanBeRuled(crossRead);

  const rule = async (verdict: CrossReadVerdict['verdict']) => {
    const normalizedReason = reason.trim();
    if (!normalizedReason) {
      setError('Explain why the readings agree or disagree.');
      return;
    }
    const normalizedClaimText = claimText.trim();
    if (!normalizedClaimText) {
      setError('Write the claim these readings should produce.');
      return;
    }
    try {
      await onRule(crossRead, { verdict, reason: normalizedReason }, normalizedClaimText);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <article className="cross-read-card">
      <header>
        <div>
          <h3>{crossRead.question}</h3>
          <p>{crossRead.sourceIds.map((sourceId) => sourcesById.get(sourceId)?.title ?? sourceId).join(', ')}</p>
        </div>
        <span className="cross-read-state">
          {crossRead.verdict ?? (canRule ? 'Needs your ruling' : settled ? 'Not enough answers' : 'Reading')}
        </span>
      </header>
      <div className="reading-grid">
        {crossRead.readings.map((reading) => (
          <section
            className="reading-side"
            data-state={reading.state}
            key={reading.memberId}
          >
            <header>
              <strong>{memberNamesById.get(reading.memberId) ?? reading.memberId}</strong>
              <span>{reading.provider ?? 'Provider not reported'}</span>
            </header>
            {reading.state === 'pending' ? (
              <div className="reading-pending">
                <span className="skeleton" />
                <span
                  className="skeleton"
                  data-size="medium"
                />
                <p>Reading independently</p>
              </div>
            ) : reading.state === 'failed' ? (
              <p className="field-error">{reading.failureReason}</p>
            ) : (
              <>
                <p className="reading-answer">{reading.answer}</p>
                <div className="reading-citations">
                  {reading.citations.map((citation, index) => (
                    <blockquote key={`${citation.sourceId}:${citation.locator ?? index}`}>
                      <p>{citation.excerpt}</p>
                      <cite>
                        {sourcesById.get(citation.sourceId)?.title ?? citation.sourceId}
                        {citation.locator ? `, ${citation.locator}` : ''}
                      </cite>
                    </blockquote>
                  ))}
                </div>
              </>
            )}
          </section>
        ))}
      </div>
      {crossRead.verdict ? (
        <div className="cross-read-verdict">
          <strong>{crossRead.verdict === 'agreed' ? 'You ruled: agree' : 'You ruled: disagree'}</strong>
          <p>{crossRead.verdictReason}</p>
          {crossRead.producedEvidenceId ? <span>Evidence {crossRead.producedEvidenceId}</span> : null}
        </div>
      ) : (
        <div className="cross-read-ruling">
          <label>
            <span>Claim to add</span>
            <textarea
              disabled={!canRule || pending}
              onChange={(event) => setClaimText(event.currentTarget.value)}
              placeholder="State the falsifiable claim these readings support or contest."
              value={claimText}
            />
          </label>
          <label>
            <span>Your reason</span>
            <textarea
              disabled={!canRule || pending}
              onChange={(event) => setReason(event.currentTarget.value)}
              placeholder={canRule ? 'What makes these readings agree or disagree?' : 'Wait for two answered readings.'}
              value={reason}
            />
          </label>
          {error ? (
            <p
              className="field-error"
              role="alert"
            >
              {error}
            </p>
          ) : null}
          <div className="mesh-form-actions">
            <span>{canRule ? 'No automatic comparison is applied.' : 'Two readers must answer before a ruling.'}</span>
            <button
              disabled={!canRule || pending}
              onClick={() => void rule('disagreed')}
              type="button"
            >
              They disagree
            </button>
            <button
              className="primary"
              disabled={!canRule || pending}
              onClick={() => void rule('agreed')}
              type="button"
            >
              They agree
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
