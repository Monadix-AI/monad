import type { SourceRef } from '../domain/index.ts';

import { useEffect, useRef, useState } from 'react';

import { sourceStatusDetail, sourceStatusTone } from '../client-logic.ts';
import { StatusChip } from './status-chip.tsx';

export function SourcesPane({
  focused,
  linkedSourceIds,
  onAdd,
  onInspect,
  sources
}: {
  focused: boolean;
  linkedSourceIds: ReadonlySet<string>;
  onAdd(): void;
  onInspect(source: SourceRef): void;
  sources: readonly SourceRef[];
}) {
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const paneRef = useRef<HTMLElement>(null);
  const visibleSources = sources.filter(
    (source) =>
      (typeFilter === 'all' || source.type === typeFilter) && (statusFilter === 'all' || source.status === statusFilter)
  );
  useEffect(() => {
    const linkedSourceId = linkedSourceIds.values().next().value;
    if (!linkedSourceId) return;
    paneRef.current
      ?.querySelector<HTMLElement>(`[data-source-id="${CSS.escape(linkedSourceId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [linkedSourceIds]);
  return (
    <section
      aria-label="Sources"
      className="pane sources-pane"
      data-focused={focused}
      ref={paneRef}
    >
      <header className="pane-header">
        <h2 className="pane-heading">
          Sources <small>{sources.length}</small>
        </h2>
        <button
          className="pane-add"
          onClick={onAdd}
          type="button"
        >
          Add source
        </button>
      </header>
      <div className="pane-body">
        <div className="pane-toolbar">
          <label>
            <span className="sr-only">Source type</span>
            <select
              aria-label="Source type"
              onChange={(event) => setTypeFilter(event.currentTarget.value)}
              value={typeFilter}
            >
              <option value="all">All types</option>
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
              <option value="supplied">Supplied</option>
            </select>
          </label>
          <label>
            <span className="sr-only">Source status</span>
            <select
              aria-label="Source status"
              onChange={(event) => setStatusFilter(event.currentTarget.value)}
              value={statusFilter}
            >
              <option value="all">All statuses</option>
              <option value="available">Available</option>
              <option value="queued">Queued</option>
              <option value="blocked">Blocked</option>
              <option value="failed">Failed</option>
              <option value="changed">Changed</option>
              <option value="unreachable">Unreachable</option>
              <option value="archived">Archived</option>
            </select>
          </label>
        </div>
        {sources.length ? (
          visibleSources.map((source) => {
            const linked = linkedSourceIds.has(source.id);
            return (
              <button
                aria-pressed={linked}
                className={linked ? 'linked selectable-card source-card' : 'selectable-card source-card'}
                data-source-id={source.id}
                key={source.id}
                onClick={() => onInspect(source)}
                type="button"
              >
                <span className="card-row">
                  <span className="card-title">{source.title}</span>
                  <StatusChip
                    label={source.status}
                    tone={sourceStatusTone(source.status)}
                  />
                </span>
                <span className="metadata source-detail">
                  {source.type} · {source.kind}
                </span>
                <span className="metadata source-detail">{sourceStatusDetail(source)}</span>
              </button>
            );
          })
        ) : (
          <div className="empty-state">
            <span className="empty-direction">
              Sources <span>→</span> Evidence <span>→</span> Report
            </span>
            <h3>Start with material you can inspect</h3>
            <p>Add a URL, local file, or project artifact. Research Desk traces claims back to captured sources.</p>
            <button
              className="primary"
              onClick={onAdd}
              type="button"
            >
              Add source
            </button>
          </div>
        )}
        {sources.length > 0 && visibleSources.length === 0 ? (
          <div className="empty-state">
            <h3>No sources match these filters</h3>
            <p>Change the type or status filter to see the rest of the research record.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
