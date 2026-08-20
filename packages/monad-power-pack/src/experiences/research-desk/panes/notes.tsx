import type { ResearchNote } from '../domain/index.ts';

import { useEffect, useState } from 'react';

export function NotesPanel({
  notes,
  onClose,
  onCreate,
  onDelete,
  onEdit,
  onPromote,
  pendingNoteIds
}: {
  notes: readonly ResearchNote[];
  onClose(): void;
  onCreate(text: string): Promise<void>;
  onDelete(note: ResearchNote): Promise<void>;
  onEdit(note: ResearchNote, text: string): Promise<void>;
  onPromote(note: ResearchNote): Promise<void>;
  pendingNoteIds: ReadonlySet<string>;
}) {
  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  return (
    <aside
      aria-label="Research notes"
      className="mesh-drawer notes-panel"
    >
      <header className="mesh-drawer-header">
        <div>
          <h2>Notes</h2>
          <p>Scratch paper only. Notes stay out of coverage, the manifest, and the report.</p>
        </div>
        <button
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </header>
      <form
        className="note-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          const text = draft.trim();
          if (!text) {
            setError('Write a note first.');
            return;
          }
          setCreating(true);
          try {
            await onCreate(text);
            setDraft('');
            setError('');
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setCreating(false);
          }
        }}
      >
        <label htmlFor="research-note-draft">New note</label>
        <textarea
          disabled={creating}
          id="research-note-draft"
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="What should you remember or check next?"
          value={draft}
        />
        <div className="mesh-form-actions">
          <span
            className="field-error"
            role={error ? 'alert' : undefined}
          >
            {error}
          </span>
          <button
            className="primary"
            disabled={creating || !draft.trim()}
            type="submit"
          >
            {creating ? 'Saving…' : 'Save note'}
          </button>
        </div>
      </form>
      <div className="note-list">
        {notes.length ? (
          notes.toReversed().map((note) => (
            <NoteEditor
              key={note.id}
              note={note}
              onDelete={onDelete}
              onEdit={onEdit}
              onPromote={onPromote}
              pending={pendingNoteIds.has(note.id)}
            />
          ))
        ) : (
          <div className="mesh-empty-state">
            <h3>No notes yet</h3>
            <p>Use notes for questions and reminders that are not ready to become evidence.</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function NoteEditor({
  note,
  onDelete,
  onEdit,
  onPromote,
  pending
}: {
  note: ResearchNote;
  onDelete(note: ResearchNote): Promise<void>;
  onEdit(note: ResearchNote, text: string): Promise<void>;
  onPromote(note: ResearchNote): Promise<void>;
  pending: boolean;
}) {
  const [text, setText] = useState(note.text);
  const [error, setError] = useState('');
  const promoted = note.promotedEvidenceId !== null;

  useEffect(() => setText(note.text), [note.text]);

  return (
    <article className="note-item">
      <div className="note-meta">
        <span>{note.authoredBy === 'human' ? 'Your note' : `Note from ${note.authorMemberId ?? 'agent'}`}</span>
        {promoted ? <strong>Promoted to {note.promotedEvidenceId}</strong> : null}
      </div>
      <label>
        <span className="sr-only">Note text</span>
        <textarea
          aria-label="Note text"
          disabled={pending || promoted}
          onChange={(event) => setText(event.currentTarget.value)}
          value={text}
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
      {!promoted ? (
        <div className="mesh-form-actions">
          <button
            disabled={pending}
            onClick={() => {
              void onDelete(note)
                .then(() => setError(''))
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
            type="button"
          >
            Delete
          </button>
          <button
            disabled={pending || text.trim() === note.text}
            onClick={() => {
              void onEdit(note, text)
                .then(() => setError(''))
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
            type="button"
          >
            Save changes
          </button>
          <button
            className="primary"
            disabled={pending || !text.trim() || text.trim() !== note.text}
            onClick={() => {
              void onPromote(note)
                .then(() => setError(''))
                .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
            type="button"
          >
            Promote to claim
          </button>
        </div>
      ) : (
        <p className="note-lock">Promoted notes stay unchanged as the claim's origin record.</p>
      )}
    </article>
  );
}
