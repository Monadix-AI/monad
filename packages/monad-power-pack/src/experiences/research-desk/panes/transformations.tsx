import type { SourceRef, Transformation, TransformationRun, TransformationSpend } from '../domain/index.ts';

import { useState } from 'react';

export function TransformationsPanel({
  onClose,
  onRun,
  pendingTransformationIds,
  runs,
  sources,
  spend,
  transformations
}: {
  onClose(): void;
  onRun(transformation: Transformation, sourceId: string | null): Promise<void>;
  pendingTransformationIds: ReadonlySet<string>;
  runs: readonly TransformationRun[];
  sources: readonly SourceRef[];
  spend: readonly TransformationSpend[];
  transformations: readonly Transformation[];
}) {
  const [sourceId, setSourceId] = useState<string | null>(sources[0]?.id ?? null);
  const [error, setError] = useState('');
  const spendById = new Map(spend.map((entry) => [entry.transformationId, entry]));

  return (
    <aside
      aria-label="Evidence transformations"
      className="mesh-drawer transformations-panel"
    >
      <header className="mesh-drawer-header">
        <div>
          <h2>Evidence recipes</h2>
          <p>Route each reading task to the role and model tier suited to the work.</p>
        </div>
        <button
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </header>
      <label className="mesh-select-row">
        <span>Source to read</span>
        <select
          onChange={(event) => setSourceId(event.currentTarget.value || null)}
          value={sourceId ?? ''}
        >
          <option value="">Whole research set</option>
          {sources.map((source) => (
            <option
              key={source.id}
              value={source.id}
            >
              {source.title}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p
          className="field-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      <div className="transformation-list">
        {transformations.map((transformation) => {
          const ownRuns = runs.filter((run) => run.transformationId === transformation.id);
          const latest = ownRuns.at(-1) ?? null;
          const ownSpend = spendById.get(transformation.id) ?? null;
          const pending = pendingTransformationIds.has(transformation.id);
          return (
            <article
              className="transformation-row"
              key={transformation.id}
            >
              <div className="transformation-copy">
                <h3>{transformation.label}</h3>
                <p>{transformation.instruction}</p>
                <dl className="recipe-route">
                  <div>
                    <dt>Role</dt>
                    <dd>{transformation.role.replace('-', ' ')}</dd>
                  </div>
                  <div>
                    <dt>Tier</dt>
                    <dd>{transformation.tier}</dd>
                  </div>
                  <div>
                    <dt>Output</dt>
                    <dd>{transformation.output}</dd>
                  </div>
                </dl>
              </div>
              <div className="transformation-status">
                <SpendSummary spend={ownSpend} />
                {latest?.state === 'failed' ? <span className="field-error">{latest.failureReason}</span> : null}
                {latest?.state === 'running' ? <span>Running now</span> : null}
                <button
                  className="primary"
                  disabled={pending || latest?.state === 'running'}
                  onClick={() => {
                    setError('');
                    void onRun(transformation, sourceId).catch((cause) =>
                      setError(cause instanceof Error ? cause.message : String(cause))
                    );
                  }}
                  type="button"
                >
                  {pending ? 'Starting…' : 'Run recipe'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </aside>
  );
}

function SpendSummary({ spend }: { spend: TransformationSpend | null }) {
  if (!spend) return <span className="recipe-spend">Not run yet</span>;
  if (spend.tokens === null || spend.cost === null) {
    return <span className="recipe-spend">{spend.runs} runs, Usage not reported</span>;
  }
  const cost = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: spend.cost.currency
  }).format(spend.cost.amount);
  return (
    <span className="recipe-spend">
      {spend.runs} runs, {spend.tokens.toLocaleString()} tokens, {cost}
    </span>
  );
}

export function TransformationLedger({ spend }: { spend: readonly TransformationSpend[] }) {
  if (!spend.length) return null;
  return (
    <section
      aria-label="Transformation usage"
      className="transformation-ledger"
    >
      <header>
        <h3>Recipe usage</h3>
        <span>Provider-reported values only</span>
      </header>
      <dl>
        {spend.map((entry) => (
          <div key={entry.transformationId}>
            <dt>
              {entry.label} <small>{entry.tier}</small>
            </dt>
            <dd>
              <SpendSummary spend={entry} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
