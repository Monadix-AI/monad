import type { WorkplaceExperienceApiContext } from '@monad/sdk-atom';
import type { CrossRead, ResearchNote, SourceVisibility, Transformation, TransformationRun } from './domain/index.ts';

import {
  BUILT_IN_TRANSFORMATIONS,
  makeVisibility,
  normalizeCrossRead,
  normalizeNote,
  normalizeTransformation,
  normalizeTransformationRun,
  normalizeVisibility
} from './domain/index.ts';
import { NotFoundError, swapRecord } from './store.ts';

const TRANSFORMATION_PREFIX = 'transformation/';
const RUN_PREFIX = 'run/';
const CROSS_READ_PREFIX = 'crossread/';
const NOTE_PREFIX = 'note/';
const VISIBILITY_KEY = 'visibility/current';

/** The mesh-side index: recipes and their runs, cross-reads, notes, and the per-member visibility
 *  rules. Same rules as the three-pane index it sits beside — a versioned projection, written with
 *  compare-and-swap, never the canonical record of the work. */
export class ResearchMeshStore {
  constructor(readonly context: WorkplaceExperienceApiContext) {}

  private swap<T extends { version: number }>(
    projectId: string,
    key: string,
    expectedVersion: number | null,
    value: T,
    event: { type: string; [key: string]: unknown }
  ): Promise<T> {
    return swapRecord(this.context, projectId, key, expectedVersion, value, event);
  }

  /** Built-ins are merged in rather than seeded into state, so an operator who never customises them
   *  gets the current recipe set after an upgrade instead of a snapshot of whatever shipped first. */
  async listTransformations(projectId: string): Promise<Transformation[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, TRANSFORMATION_PREFIX);
    const custom = records.map((record) => normalizeTransformation(record.value));
    const overridden = new Set(custom.map((entry) => entry.id));
    return [...BUILT_IN_TRANSFORMATIONS.filter((entry) => !overridden.has(entry.id)), ...custom];
  }

  async requireTransformation(projectId: string, transformationId: string): Promise<Transformation> {
    const found = (await this.listTransformations(projectId)).find((entry) => entry.id === transformationId);
    if (!found) throw new NotFoundError(`transformation not found: ${transformationId}`);
    return found;
  }

  async putTransformation(projectId: string, transformation: Transformation): Promise<Transformation> {
    const key = `${TRANSFORMATION_PREFIX}${transformation.id}`;
    const record = await this.context.experienceState.get<unknown>(projectId, key);
    await this.context.experienceState.compareAndSwap({
      projectId,
      key,
      expectedVersion: record?.version ?? null,
      value: transformation,
      event: { type: 'transformation.updated', transformationId: transformation.id }
    });
    return transformation;
  }

  async listRuns(projectId: string): Promise<TransformationRun[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, RUN_PREFIX);
    return records
      .map((record) => normalizeTransformationRun(record.value))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
  }

  async getRun(projectId: string, runId: string): Promise<TransformationRun | null> {
    const record = await this.context.experienceState.get<unknown>(projectId, `${RUN_PREFIX}${runId}`);
    if (!record) return null;
    const run = normalizeTransformationRun(record.value);
    if (run.version !== record.version) throw new Error(`corrupt transformation run record: ${runId}`);
    return run;
  }

  async requireRun(projectId: string, runId: string): Promise<TransformationRun> {
    const run = await this.getRun(projectId, runId);
    if (!run) throw new NotFoundError(`transformation run not found: ${runId}`);
    return run;
  }

  async putRun(run: TransformationRun, expectedVersion: number | null): Promise<TransformationRun> {
    return this.swap(run.projectId, `${RUN_PREFIX}${run.id}`, expectedVersion, run, {
      type: 'transformation.run',
      runId: run.id,
      transformationId: run.transformationId,
      state: run.state
    });
  }

  async listCrossReads(projectId: string): Promise<CrossRead[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, CROSS_READ_PREFIX);
    return records
      .map((record) => normalizeCrossRead(record.value))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async getCrossRead(projectId: string, crossReadId: string): Promise<CrossRead | null> {
    const record = await this.context.experienceState.get<unknown>(projectId, `${CROSS_READ_PREFIX}${crossReadId}`);
    if (!record) return null;
    const crossRead = normalizeCrossRead(record.value);
    if (crossRead.version !== record.version) throw new Error(`corrupt cross-read record: ${crossReadId}`);
    return crossRead;
  }

  async requireCrossRead(projectId: string, crossReadId: string): Promise<CrossRead> {
    const crossRead = await this.getCrossRead(projectId, crossReadId);
    if (!crossRead) throw new NotFoundError(`cross-read not found: ${crossReadId}`);
    return crossRead;
  }

  async putCrossRead(crossRead: CrossRead, expectedVersion: number | null): Promise<CrossRead> {
    return this.swap(crossRead.projectId, `${CROSS_READ_PREFIX}${crossRead.id}`, expectedVersion, crossRead, {
      type: 'crossread.updated',
      crossReadId: crossRead.id,
      verdict: crossRead.verdict
    });
  }

  /** The cross-read a member's session is currently answering, if any. The worker needs this to route
   *  an incoming answer back to the right question without the agent having to quote an id. */
  async pendingCrossReadFor(projectId: string, sessionId: string): Promise<CrossRead | null> {
    const open = (await this.listCrossReads(projectId)).filter((crossRead) =>
      crossRead.readings.some((reading) => reading.sessionId === sessionId && reading.state === 'pending')
    );
    return open.at(-1) ?? null;
  }

  async listNotes(projectId: string): Promise<ResearchNote[]> {
    const records = await this.context.experienceState.list<unknown>(projectId, NOTE_PREFIX);
    return records
      .map((record) => normalizeNote(record.value))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }

  async requireNote(projectId: string, noteId: string): Promise<ResearchNote> {
    const record = await this.context.experienceState.get<unknown>(projectId, `${NOTE_PREFIX}${noteId}`);
    if (!record) throw new NotFoundError(`note not found: ${noteId}`);
    const note = normalizeNote(record.value);
    if (note.version !== record.version) throw new Error(`corrupt note record: ${noteId}`);
    return note;
  }

  async putNote(note: ResearchNote, expectedVersion: number | null): Promise<ResearchNote> {
    return this.swap(note.projectId, `${NOTE_PREFIX}${note.id}`, expectedVersion, note, {
      type: 'note.updated',
      noteId: note.id
    });
  }

  async deleteNote(projectId: string, noteId: string, expectedVersion: number): Promise<void> {
    const removed = await this.context.experienceState.compareAndDelete({
      projectId,
      key: `${NOTE_PREFIX}${noteId}`,
      expectedVersion,
      event: { type: 'note.deleted', noteId }
    });
    if (!removed) throw new Error(`version conflict: expected ${expectedVersion}`);
  }

  /** Null when the project never opened the matrix. The caller starts an empty rule set from
   *  `makeVisibility` and writes it with `expectedVersion: null`, which keeps "never configured" and
   *  "configured, then emptied" distinguishable at the state layer. */
  async getVisibility(projectId: string): Promise<SourceVisibility | null> {
    const record = await this.context.experienceState.get<unknown>(projectId, VISIBILITY_KEY);
    if (!record) return null;
    const visibility = normalizeVisibility(record.value);
    if (visibility.version !== record.version) throw new Error('corrupt visibility record');
    return visibility;
  }

  async visibilityOrEmpty(projectId: string, now: string): Promise<SourceVisibility> {
    return (await this.getVisibility(projectId)) ?? makeVisibility(projectId, now);
  }

  async putVisibility(visibility: SourceVisibility, expectedVersion: number | null): Promise<SourceVisibility> {
    return this.swap(visibility.projectId, VISIBILITY_KEY, expectedVersion, visibility, {
      type: 'visibility.updated',
      rules: visibility.rules.length
    });
  }
}
