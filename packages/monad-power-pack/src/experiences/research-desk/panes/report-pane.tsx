import type { BlockCoverage, BlockPatch, Report, ReportBlock, ReportBlockKind } from '../domain/index.ts';

import { useEffect, useRef, useState } from 'react';

import { coverageByBlock, reportBlockIsBlocked } from '../client-logic.ts';

const BLOCK_KINDS: ReportBlockKind[] = ['factual', 'analysis', 'limitation', 'method'];

export function ReportPane({
  coverage,
  focused,
  linkedReportBlockIds,
  onCreate,
  onSave,
  onSelect,
  onSelectEvidence,
  pendingBlockIds,
  report,
  selectedBlockId
}: {
  coverage: readonly BlockCoverage[];
  focused: boolean;
  linkedReportBlockIds: ReadonlySet<string>;
  onCreate(): void;
  onSave(block: ReportBlock, patch: BlockPatch): Promise<void>;
  onSelect(blockId: string): void;
  onSelectEvidence(evidenceId: string): void;
  pendingBlockIds: ReadonlySet<string>;
  report: Report | null;
  selectedBlockId: string | null;
}) {
  const byBlock = coverageByBlock(coverage);
  const coveredCount = coverage.filter((item) => item.missing === 0).length;
  const paneRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selectedBlockId) return;
    const block = paneRef.current?.querySelector<HTMLElement>(
      `[data-report-block-id="${CSS.escape(selectedBlockId)}"]`
    );
    block?.scrollIntoView({ block: 'nearest' });
    block?.focus();
  }, [selectedBlockId]);
  useEffect(() => {
    const linkedBlockId = linkedReportBlockIds.values().next().value;
    if (!linkedBlockId) return;
    paneRef.current
      ?.querySelector<HTMLElement>(`[data-report-block-id="${CSS.escape(linkedBlockId)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [linkedReportBlockIds]);
  return (
    <section
      aria-label="Report"
      className="pane report-pane"
      data-focused={focused}
      ref={paneRef}
    >
      <header className="pane-header">
        <h2 className="pane-heading">
          Report <small>{report ? `${report.state} · rev ${report.revision}` : 'not started'}</small>
        </h2>
        <span className="pane-meta">
          coverage {coveredCount} / {coverage.length} blocks
        </span>
      </header>
      <div className="pane-body">
        {report?.blocks.length ? (
          report.blocks.map((block) => {
            const blockCoverage = byBlock.get(block.id);
            const blocked = reportBlockIsBlocked(block, blockCoverage);
            const linked = linkedReportBlockIds.has(block.id);
            const selected = selectedBlockId === block.id;
            return (
              <div key={block.id}>
                <button
                  aria-expanded={selected}
                  className={linked ? 'linked report-block selectable-card' : 'report-block selectable-card'}
                  data-blocked={blocked}
                  data-report-block-id={block.id}
                  onClick={() => onSelect(block.id)}
                  type="button"
                >
                  <span>
                    <span className="card-title">{block.heading}</span>
                    <span className="block-kind">
                      {block.kind}
                      {block.kindChangedByHuman ? ' · type changed by you' : ''}
                    </span>
                    <span className="block-markdown">{block.markdown}</span>
                    {block.evidenceIds.length ? (
                      <span className="source-detail">
                        {block.evidenceIds.map((evidenceId) => (
                          <span
                            className="citation-chip"
                            key={evidenceId}
                          >
                            {evidenceId}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <CoverageSummary
                    coverage={blockCoverage}
                    kind={block.kind}
                  />
                </button>
                {selected && report.state !== 'published' ? (
                  <BlockEditor
                    block={block}
                    onSave={onSave}
                    onSelectEvidence={onSelectEvidence}
                    pending={pendingBlockIds.has(block.id)}
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
            <h3>The report stays empty until claims arrive</h3>
            <p>
              Factual blocks need accepted evidence. Analysis, limitation, and method blocks do not require citations.
            </p>
            {!report ? (
              <button
                className="primary"
                onClick={onCreate}
                type="button"
              >
                Start research brief
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function CoverageSummary({ coverage, kind }: { coverage: BlockCoverage | undefined; kind: ReportBlockKind }) {
  if (!coverage || kind !== 'factual') return <span className="coverage">no citation required</span>;
  return (
    <span
      className="coverage"
      data-blocked={coverage.missing > 0}
    >
      {coverage.accepted} accepted
      <br />
      {coverage.contested} contested
      <br />
      <strong>{coverage.missing} missing</strong>
    </span>
  );
}

function BlockEditor({
  block,
  onSave,
  onSelectEvidence,
  pending
}: {
  block: ReportBlock;
  onSave(block: ReportBlock, patch: BlockPatch): Promise<void>;
  onSelectEvidence(evidenceId: string): void;
  pending: boolean;
}) {
  const [kind, setKind] = useState(block.kind);
  const [markdown, setMarkdown] = useState(block.markdown);
  const [error, setError] = useState('');

  useEffect(() => {
    setKind(block.kind);
    setMarkdown(block.markdown);
    setError('');
  }, [block.kind, block.markdown]);

  return (
    <form
      className="block-editor decision-panel"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await onSave(block, { kind, markdown });
          setError('');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }}
    >
      <div className="block-editor-row">
        <label>
          <span className="sr-only">Block kind</span>
          <select
            aria-label="Block kind"
            disabled={pending}
            onChange={(event) => setKind(event.currentTarget.value as ReportBlockKind)}
            value={kind}
          >
            {BLOCK_KINDS.map((value) => (
              <option
                key={value}
                value={value}
              >
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primary"
          disabled={pending || (kind === block.kind && markdown === block.markdown)}
          type="submit"
        >
          Save block
        </button>
      </div>
      <label>
        <span className="sr-only">Block content</span>
        <textarea
          aria-label="Block content"
          disabled={pending}
          onChange={(event) => setMarkdown(event.currentTarget.value)}
          value={markdown}
        />
      </label>
      {block.evidenceIds.length ? (
        <div className="decision-actions">
          {block.evidenceIds.map((evidenceId) => (
            <button
              key={evidenceId}
              onClick={() => onSelectEvidence(evidenceId)}
              type="button"
            >
              View {evidenceId}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p
          className="field-error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}
