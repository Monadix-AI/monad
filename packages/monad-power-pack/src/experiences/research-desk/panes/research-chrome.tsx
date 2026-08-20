import type { FocusedPane, PublishConflict, ResearchOverview } from '../client-logic.ts';
import type { BlockCoverage, Report, ResearchAssignment, SourceKind, SourceType } from '../domain/index.ts';

import { useState } from 'react';

const STAGES: ResearchOverview['stage'][] = ['collecting', 'verifying', 'synthesizing', 'review', 'published'];

export function ResearchTopbar({
  overview,
  onPublish,
  publishing,
  report
}: {
  overview: ResearchOverview | null;
  onPublish(): void;
  publishing: boolean;
  report: Report | null;
}) {
  return (
    <header className="research-topbar">
      <div className="brief">
        <h1>{overview?.report?.title ?? report?.title ?? 'Research Desk'}</h1>
        <p>
          {overview?.report?.question ?? report?.question ?? 'Define a research question to begin.'}
          {(overview?.report?.doneWhen ?? report?.doneWhen)
            ? ` · Done when: ${overview?.report?.doneWhen ?? report?.doneWhen}`
            : ''}
        </p>
      </div>
      <nav
        aria-label="Research stage"
        className="stages"
      >
        {STAGES.map((stage) => (
          <span
            className="stage"
            data-active={overview?.stage === stage}
            key={stage}
          >
            {stage}
          </span>
        ))}
      </nav>
      <div className="members">
        {(overview?.members ?? []).map((member) => (
          <span
            className="member-status"
            data-active={member.role !== 'other'}
            key={member.memberId}
          >
            {member.displayName} <small>{member.role.replace('-', ' ')}</small>
          </span>
        ))}
      </div>
      <div className="usage">
        {!overview || (overview.usage.tokens === null && overview.usage.cost === null) ? (
          <span className="usage-cost">Usage not reported</span>
        ) : (
          <>
            <span>
              {overview.usage.tokens === null
                ? 'Tokens not reported'
                : `${overview.usage.tokens.toLocaleString()} tokens`}
            </span>
            <span className="usage-cost">
              {overview.usage.cost
                ? new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: overview.usage.cost.currency
                  }).format(overview.usage.cost.amount)
                : 'Cost not reported'}
            </span>
          </>
        )}
      </div>
      <div className="topbar-actions">
        <button
          className="primary"
          disabled={publishing || report?.state === 'published'}
          onClick={onPublish}
          type="button"
        >
          {report?.state === 'published' ? 'Published' : publishing ? 'Checking…' : 'Publish'}
        </button>
      </div>
    </header>
  );
}

export function FocusSwitcher({ focused, onFocus }: { focused: FocusedPane; onFocus(value: FocusedPane): void }) {
  return (
    <nav
      aria-label="Research view"
      className="focus-switcher"
    >
      {(['sources', 'evidence', 'report'] as const).map((pane) => (
        <button
          data-active={focused === pane}
          key={pane}
          onClick={() => onFocus(pane)}
          type="button"
        >
          {pane}
        </button>
      ))}
    </nav>
  );
}

export function AssignmentStrip({ assignments }: { assignments: readonly ResearchAssignment[] }) {
  const visible = assignments.slice(-4).toReversed();
  if (!visible.length) return null;
  return (
    <section
      aria-label="Mesh assignments"
      className="assignment-strip"
    >
      <strong>Mesh work</strong>
      {visible.map((assignment) => (
        <span
          className="assignment-item"
          data-state={assignment.state}
          key={assignment.id}
          title={assignment.objective}
        >
          <span>{assignment.role.replace('-', ' ')}</span>
          <small>{assignment.targetClaimId ?? assignment.targetBlockId ?? 'research brief'}</small>
          <b>{assignment.state}</b>
        </span>
      ))}
    </section>
  );
}

export function ActivityBar({ activity }: { activity: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const latest = activity.at(-1) ?? 'Waiting for the first research activity.';
  const occurrenceByMessage = new Map<string, number>();
  const rows = activity.toReversed().map((message) => {
    const occurrence = (occurrenceByMessage.get(message) ?? 0) + 1;
    occurrenceByMessage.set(message, occurrence);
    return { id: `${message}:${occurrence}`, message };
  });
  return (
    <>
      <footer className="activity-bar">
        <strong>Activity</strong>
        <span className="activity-item">{latest}</span>
        <button
          aria-expanded={open}
          className="activity-toggle"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          {open ? 'Close' : `${activity.length} records`}
        </button>
      </footer>
      {open ? (
        <aside
          aria-label="Research activity"
          className="activity-drawer"
        >
          <header>
            <h2>Activity</h2>
            <button
              onClick={() => setOpen(false)}
              type="button"
            >
              Close
            </button>
          </header>
          {activity.length ? (
            <ol>
              {rows.map((row) => (
                <li key={row.id}>{row.message}</li>
              ))}
            </ol>
          ) : (
            <p>Research activity will appear here, including normal reconnect recovery.</p>
          )}
        </aside>
      ) : null}
    </>
  );
}

export function PublishBlockedDialog({
  conflict,
  onClose,
  onDispatch,
  dispatching,
  onGoToBlock
}: {
  conflict: PublishConflict;
  onClose(): void;
  onDispatch(blockId: string): Promise<void>;
  dispatching: boolean;
  onGoToBlock(blockId: string): void;
}) {
  const count = conflict.blockedBlocks.length;
  const first = conflict.blockedBlocks[0];
  if (!first) return null;
  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      role="dialog"
    >
      <section className="dialog blocked-dialog">
        <h2>
          Can’t publish: {count} factual {count === 1 ? 'block needs' : 'blocks need'} accepted evidence
        </h2>
        <p>Analysis, limitation, and method blocks are not checked. Add or accept evidence for these factual blocks:</p>
        <ol className="blocked-list">
          {conflict.blockedBlocks.map((block: BlockCoverage) => (
            <li key={block.blockId}>
              <strong>{block.heading}</strong> — {block.accepted} accepted / {block.contested} contested /{' '}
              {block.missing} missing
            </li>
          ))}
        </ol>
        <p className="dialog-note">There is no publish override. The first blocked block is ready to inspect.</p>
        <div className="dialog-actions">
          <button
            onClick={onClose}
            type="button"
          >
            Close
          </button>
          <button
            disabled={dispatching}
            onClick={() => void onDispatch(first.blockId)}
            type="button"
          >
            {dispatching ? 'Dispatching…' : 'Dispatch missing evidence'}
          </button>
          <button
            className="primary"
            onClick={() => onGoToBlock(first.blockId)}
            type="button"
          >
            Go to first blocked block
          </button>
        </div>
      </section>
    </div>
  );
}

export function AddSourceDialog({
  onClose,
  onSubmit,
  pending
}: {
  onClose(): void;
  onSubmit(value: { kind: SourceKind; type: SourceType; title: string; locator: string }): Promise<void>;
  pending: boolean;
}) {
  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      role="dialog"
    >
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void onSubmit({
            kind: String(data.get('kind')) as SourceKind,
            type: String(data.get('type')) as SourceType,
            title: String(data.get('title') ?? '').trim(),
            locator: String(data.get('locator') ?? '').trim()
          });
        }}
      >
        <h2>Add source</h2>
        <p>Add inspectable material. A captured snapshot and fingerprint will anchor later citations.</p>
        <label>
          <span>Title</span>
          <input
            disabled={pending}
            name="title"
            required
          />
        </label>
        <label>
          <span>URL or path</span>
          <input
            disabled={pending}
            name="locator"
            required
          />
        </label>
        <div className="dialog-fields">
          <label>
            <span>Kind</span>
            <select
              defaultValue="url"
              disabled={pending}
              name="kind"
            >
              <option value="url">URL</option>
              <option value="file">File</option>
              <option value="project-artifact">Project artifact</option>
            </select>
          </label>
          <label>
            <span>Type</span>
            <select
              defaultValue="secondary"
              disabled={pending}
              name="type"
            >
              <option value="primary">Primary</option>
              <option value="secondary">Secondary</option>
              <option value="supplied">Supplied</option>
            </select>
          </label>
        </div>
        <div className="dialog-actions">
          <button
            disabled={pending}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={pending}
            type="submit"
          >
            {pending ? 'Adding…' : 'Add source'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function CreateReportDialog({
  onClose,
  onSubmit,
  pending
}: {
  onClose(): void;
  onSubmit(value: { title: string; question: string; doneWhen?: string }): Promise<void>;
  pending: boolean;
}) {
  return (
    <div
      aria-modal="true"
      className="dialog-backdrop"
      role="dialog"
    >
      <form
        className="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const doneWhen = String(data.get('doneWhen') ?? '').trim();
          void onSubmit({
            title: String(data.get('title') ?? '').trim(),
            question: String(data.get('question') ?? '').trim(),
            ...(doneWhen ? { doneWhen } : {})
          });
        }}
      >
        <h2>Start a research brief</h2>
        <p>The question and completion standard stay visible above all three panes.</p>
        <label>
          <span>Brief title</span>
          <input
            disabled={pending}
            name="title"
            required
          />
        </label>
        <label>
          <span>Research question</span>
          <textarea
            disabled={pending}
            name="question"
            required
          />
        </label>
        <label>
          <span>Done when</span>
          <textarea
            disabled={pending}
            name="doneWhen"
            placeholder="Every factual claim has accepted evidence."
          />
        </label>
        <div className="dialog-actions">
          <button
            disabled={pending}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="primary"
            disabled={pending}
            type="submit"
          >
            {pending ? 'Starting…' : 'Start research'}
          </button>
        </div>
      </form>
    </div>
  );
}
