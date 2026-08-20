import { z } from 'zod';

import { definedOnly } from './defaults.ts';

/** Scratch paper. A note is what a person thinks while reading — "this number looks wrong", "ask
 *  legal" — and it deliberately carries none of a claim's obligations: no citation, no status, no
 *  ruling. It never reaches coverage, the manifest, or an export.
 *
 *  Without this lane those thoughts get typed into a claim (which pollutes the evidence pool with
 *  unfalsifiable text) or into the report (which pollutes the deliverable). */
const noteSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  projectId: z.string().min(1),
  text: z.string().min(1).max(20_000),
  authoredBy: z.enum(['human', 'agent']),
  authorMemberId: z.string().min(1).nullable(),
  sourceId: z.string().min(1).nullable(),
  evidenceId: z.string().min(1).nullable(),
  promotedEvidenceId: z.string().min(1).nullable(),
  version: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export type ResearchNote = z.infer<typeof noteSchema>;

export function makeNote(
  input: Pick<ResearchNote, 'id' | 'projectId' | 'text'> &
    Partial<Omit<ResearchNote, 'schemaVersion' | 'id' | 'projectId' | 'text'>>
): ResearchNote {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return noteSchema.parse({
    schemaVersion: 1,
    authoredBy: 'human',
    authorMemberId: null,
    sourceId: null,
    evidenceId: null,
    promotedEvidenceId: null,
    version: 0,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    ...definedOnly(input)
  });
}

export function normalizeNote(value: unknown): ResearchNote {
  return noteSchema.parse(value);
}

function assertVersion(note: ResearchNote, expectedVersion: number): void {
  if (note.version !== expectedVersion) {
    throw new Error(`version conflict: expected ${expectedVersion}, current ${note.version}`);
  }
}

export function editNote(note: ResearchNote, expectedVersion: number, text: string, now: string): ResearchNote {
  assertVersion(note, expectedVersion);
  const trimmed = text.trim();
  if (!trimmed) throw new Error('a note cannot be empty');
  if (note.promotedEvidenceId) throw new Error('a promoted note is kept as written');
  return { ...note, text: trimmed, version: note.version + 1, updatedAt: now };
}

/** Promotion is the only bridge from scratch paper to the evidence pool, and it is one-way: the note
 *  stays as the record of where the claim came from. */
export function markNotePromoted(
  note: ResearchNote,
  expectedVersion: number,
  evidenceId: string,
  now: string
): ResearchNote {
  assertVersion(note, expectedVersion);
  if (note.promotedEvidenceId) throw new Error('this note was already promoted');
  return { ...note, promotedEvidenceId: evidenceId, version: note.version + 1, updatedAt: now };
}
