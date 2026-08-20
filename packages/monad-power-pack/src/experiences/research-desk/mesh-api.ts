import type { WorkplaceExperienceApiContext, WorkplaceExperienceApiRoute } from '@monad/sdk-atom';
import type { CrossReading } from './domain/index.ts';

import { z } from 'zod';

import { guard } from './api.ts';
import {
  addCitation,
  claimFromCrossRead,
  editNote,
  makeCrossRead,
  makeEvidenceClaim,
  makeNote,
  makeTransformationRun,
  makeVisibility,
  markClaimProduced,
  markNotePromoted,
  readableSources,
  ruleOnCrossRead,
  setRule,
  spendByTransformation,
  visibilityMatrix
} from './domain/index.ts';
import { ResearchMeshStore } from './mesh-store.ts';
import { ResearchDeskStore, researchDeskId } from './store.ts';

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function now(): string {
  return new Date().toISOString();
}

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  return schema.parse(await request.json());
}

function projectIdOf(request: Request): string {
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) throw new Error('projectId is required');
  return projectId;
}

const CROSS_READ_MIN_READERS = 2;

async function listTransformations(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const projectId = projectIdOf(request);
  const store = new ResearchMeshStore(context);
  const [transformations, runs] = await Promise.all([store.listTransformations(projectId), store.listRuns(projectId)]);
  return json({ transformations, runs, spend: spendByTransformation(runs, transformations) });
}

const runTransformationSchema = z.object({
  projectId: z.string().min(1),
  transformationId: z.string().min(1),
  sourceId: z.string().min(1).optional()
});

/** Dispatch a recipe to the member its role names. The tier travels in the prompt as the requested
 *  capability class rather than a vendor model id, so a recipe stays portable across whatever the
 *  operator has configured. */
async function runTransformation(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, runTransformationSchema);
  const mesh = new ResearchMeshStore(context);
  const desk = new ResearchDeskStore(context);
  const transformation = await mesh.requireTransformation(input.projectId, input.transformationId);
  const members = await context.projectMembers.listTemplates(input.projectId);
  const member = members.find((entry) => entry.name === transformation.role);
  if (!member) throw new Error(`this project has no ${transformation.role} member`);
  const sessions = await context.projectSessions.list(input.projectId);
  const session = sessions[0];
  if (!session) throw new Error('this project has no session to run in');

  const visibility = await mesh.visibilityOrEmpty(input.projectId, now());
  const sources = readableSources(visibility, member.id, await desk.listSources(input.projectId));
  const target = input.sourceId ? sources.find((source) => source.id === input.sourceId) : undefined;
  if (input.sourceId && !target) {
    // Either the source does not exist or this member may not read it. Both answer the same way on
    // purpose: the matrix is a reading rule, not a discovery channel for what else is in the project.
    throw new Error(`this member cannot read source ${input.sourceId}`);
  }

  const startedAt = now();
  const run = makeTransformationRun({
    id: researchDeskId('run', input.projectId, `${transformation.id}:${input.sourceId ?? 'all'}:${startedAt}`),
    projectId: input.projectId,
    transformationId: transformation.id,
    sourceId: input.sourceId ?? null,
    memberId: member.id,
    sessionId: session.id,
    startedAt
  });
  const saved = await mesh.putRun(run, null);
  await context.projectSessions.sendMessage(session.id, {
    text: [
      `[${transformation.label} · ${transformation.tier} tier · run ${saved.id}]`,
      transformation.instruction,
      target ? `Source: ${target.title} — ${target.locator}` : `Readable sources: ${sources.length}`,
      'Report each result as a ```research-desk fenced JSON block.'
    ].join('\n\n'),
    idempotencyKey: `research-desk:transformation:${saved.id}`
  });
  return json({ run: saved, transformation }, 201);
}

async function listCrossReads(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return json({ crossReads: await new ResearchMeshStore(context).listCrossReads(projectIdOf(request)) });
}

const startCrossReadSchema = z.object({
  projectId: z.string().min(1),
  question: z.string().min(1).max(4_000),
  sourceIds: z.array(z.string().min(1)).max(50).default([]),
  memberIds: z.array(z.string().min(1)).min(CROSS_READ_MIN_READERS).max(4)
});

/** Send one question to several members at once, each in its own session, with no member seeing the
 *  others' answer. Asking twice is only worth anything if the second reader is genuinely independent,
 *  so the readers must be distinct and there must be at least two of them. */
async function startCrossRead(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, startCrossReadSchema);
  const unique = new Set(input.memberIds);
  if (unique.size !== input.memberIds.length) throw new Error('a cross-read needs distinct readers');
  const mesh = new ResearchMeshStore(context);
  const desk = new ResearchDeskStore(context);
  const templates = await context.projectMembers.listTemplates(input.projectId);
  const startedAt = now();
  const visibility = await mesh.visibilityOrEmpty(input.projectId, startedAt);
  const allSources = await desk.listSources(input.projectId);

  const readings: CrossReading[] = [];
  for (const memberId of input.memberIds) {
    const template = templates.find((entry) => entry.id === memberId);
    if (!template) throw new Error(`member not found: ${memberId}`);
    const created = await context.projectSessions.create(input.projectId, {
      title: `Cross-read · ${template.displayName ?? template.name}`,
      idempotencyKey: `research-desk:crossread:${input.projectId}:${memberId}:${startedAt}`
    });
    readings.push({
      memberId,
      provider: template.settings?.modelId ?? null,
      sessionId: created.id,
      answer: null,
      citations: [],
      state: 'pending',
      failureReason: null,
      answeredAt: null
    });
  }

  const crossRead = makeCrossRead({
    id: researchDeskId('xr', input.projectId, `${input.question}:${startedAt}`),
    projectId: input.projectId,
    question: input.question,
    sourceIds: input.sourceIds,
    readings,
    createdAt: startedAt
  });
  const saved = await mesh.putCrossRead(crossRead, null);

  for (const reading of saved.readings) {
    const readable = readableSources(visibility, reading.memberId, allSources).filter(
      (source) => input.sourceIds.length === 0 || input.sourceIds.includes(source.id)
    );
    await context.projectSessions.sendMessage(reading.sessionId, {
      text: [
        `[Cross-read ${saved.id}] Answer independently. Do not look for another agent's answer.`,
        saved.question,
        readable.map((source) => `- ${source.title} — ${source.locator}`).join('\n') || 'No readable sources.',
        'Answer in one paragraph, then list every excerpt you relied on as a ```research-desk fenced JSON block with record "crossread-answer".'
      ].join('\n\n'),
      idempotencyKey: `research-desk:crossread:${saved.id}:${reading.memberId}`
    });
  }
  return json({ crossRead: saved }, 201);
}

const ruleCrossReadSchema = z.object({
  projectId: z.string().min(1),
  crossReadId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  verdict: z.enum(['agreed', 'disagreed']),
  reason: z.string().max(4_000),
  claimText: z.string().min(1).max(4_000)
});

/** The human's ruling, and the claim it produces. A disagreement lands in the pool as `contested`
 *  with both vendors' material attached — the split is preserved as work to do, not resolved by the
 *  system into an average nobody chose. */
async function ruleCrossRead(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, ruleCrossReadSchema);
  const mesh = new ResearchMeshStore(context);
  const desk = new ResearchDeskStore(context);
  const crossRead = await mesh.requireCrossRead(input.projectId, input.crossReadId);
  const ruledAt = now();
  const ruled = ruleOnCrossRead(
    crossRead,
    input.expectedVersion,
    { verdict: input.verdict, reason: input.reason },
    ruledAt
  );
  const seed = claimFromCrossRead(ruled, {
    id: researchDeskId('evd', input.projectId, `${ruled.id}:${input.claimText}`),
    text: input.claimText,
    proposedByMemberId: ruled.readings[0]?.memberId ?? 'agent',
    sessionId: ruled.readings[0]?.sessionId ?? ''
  });
  let claim = makeEvidenceClaim({
    id: seed.id,
    projectId: input.projectId,
    text: seed.text,
    proposedByMemberId: seed.proposedByMemberId,
    sessionId: seed.sessionId,
    createdAt: ruledAt
  });
  for (const citation of seed.citations) {
    claim = addCitation(claim, claim.version, citation, ruledAt);
  }
  const savedClaim = await desk.putClaim(claim, null);
  // The ruling and the claim link are one write: persisting the verdict first would leave a ruled
  // cross-read pointing at no claim if the claim write failed.
  const savedCrossRead = await mesh.putCrossRead(
    markClaimProduced(ruled, ruled.version, savedClaim.id, ruledAt),
    input.expectedVersion
  );
  return json({ crossRead: savedCrossRead, evidence: savedClaim });
}

async function listNotes(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return json({ notes: await new ResearchMeshStore(context).listNotes(projectIdOf(request)) });
}

const addNoteSchema = z.object({
  projectId: z.string().min(1),
  text: z.string().min(1).max(20_000),
  sourceId: z.string().min(1).optional(),
  evidenceId: z.string().min(1).optional()
});

async function addNote(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, addNoteSchema);
  const createdAt = now();
  const note = makeNote({
    id: researchDeskId('note', input.projectId, `${input.text}:${createdAt}`),
    projectId: input.projectId,
    text: input.text,
    sourceId: input.sourceId ?? null,
    evidenceId: input.evidenceId ?? null,
    createdAt
  });
  return json({ note: await new ResearchMeshStore(context).putNote(note, null) }, 201);
}

const updateNoteSchema = z.object({
  projectId: z.string().min(1),
  noteId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  text: z.string().max(20_000)
});

async function updateNote(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, updateNoteSchema);
  const store = new ResearchMeshStore(context);
  const note = await store.requireNote(input.projectId, input.noteId);
  const edited = editNote(note, input.expectedVersion, input.text, now());
  return json({ note: await store.putNote(edited, input.expectedVersion) });
}

const deleteNoteSchema = z.object({
  projectId: z.string().min(1),
  noteId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative()
});

async function deleteNote(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, deleteNoteSchema);
  await new ResearchMeshStore(context).deleteNote(input.projectId, input.noteId, input.expectedVersion);
  return json({ deleted: true, noteId: input.noteId });
}

const promoteNoteSchema = z.object({
  projectId: z.string().min(1),
  noteId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  claimText: z.string().min(1).max(4_000)
});

/** Scratch paper becomes a claim. The note stays as the record of where it came from, so promotion is
 *  a bridge, not a move. */
async function promoteNote(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, promoteNoteSchema);
  const mesh = new ResearchMeshStore(context);
  const desk = new ResearchDeskStore(context);
  const note = await mesh.requireNote(input.projectId, input.noteId);
  const promotedAt = now();
  const claim = makeEvidenceClaim({
    id: researchDeskId('evd', input.projectId, `note:${note.id}`),
    projectId: input.projectId,
    text: input.claimText,
    proposedByMemberId: 'human',
    sessionId: 'human',
    createdAt: promotedAt
  });
  const savedClaim = await desk.putClaim(claim, null);
  const savedNote = await mesh.putNote(
    markNotePromoted(note, input.expectedVersion, savedClaim.id, promotedAt),
    input.expectedVersion
  );
  return json({ note: savedNote, evidence: savedClaim });
}

async function getVisibility(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const projectId = projectIdOf(request);
  const mesh = new ResearchMeshStore(context);
  const desk = new ResearchDeskStore(context);
  const [visibility, sources, templates] = await Promise.all([
    mesh.visibilityOrEmpty(projectId, now()),
    desk.listSources(projectId),
    context.projectMembers.listTemplates(projectId)
  ]);
  const memberIds = templates.map((template) => template.id);
  return json({
    visibility,
    matrix: visibilityMatrix(visibility, memberIds, sources),
    // Stated in the payload as well as in the UI: this filter governs what Research Desk hands a
    // member, and nothing more.
    scope: 'Controls which sources Research Desk sends to each member. It is not network isolation.'
  });
}

const setVisibilitySchema = z.object({
  projectId: z.string().min(1),
  memberId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).max(500).nullable()
});

async function setVisibility(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  const input = await body(request, setVisibilitySchema);
  const store = new ResearchMeshStore(context);
  const updatedAt = now();
  const existing = await store.getVisibility(input.projectId);
  const current = existing ?? makeVisibility(input.projectId, updatedAt);
  const next = setRule(current, current.version, { memberId: input.memberId, sourceIds: input.sourceIds }, updatedAt);
  const saved = await store.putVisibility(next, existing ? existing.version : null);
  const sources = await new ResearchDeskStore(context).listSources(input.projectId);
  const templates = await context.projectMembers.listTemplates(input.projectId);
  return json({
    visibility: saved,
    matrix: visibilityMatrix(
      saved,
      templates.map((template) => template.id),
      sources
    )
  });
}

/** Every mesh handler answers through the same failure translation as the three-pane routes: a
 *  version conflict is a 409, an unknown id is a 404, and a rejected input is a 400 carrying the
 *  domain's own message rather than a stack. */
export const researchMeshRoutes: WorkplaceExperienceApiRoute[] = (
  [
    { method: 'GET', path: '/transformations', handle: listTransformations },
    { method: 'POST', path: '/transformations/run', handle: runTransformation },
    { method: 'GET', path: '/cross-reads', handle: listCrossReads },
    { method: 'POST', path: '/cross-reads/start', handle: startCrossRead },
    { method: 'POST', path: '/cross-reads/rule', handle: ruleCrossRead },
    { method: 'GET', path: '/notes', handle: listNotes },
    { method: 'POST', path: '/notes/add', handle: addNote },
    { method: 'POST', path: '/notes/update', handle: updateNote },
    { method: 'POST', path: '/notes/delete', handle: deleteNote },
    { method: 'POST', path: '/notes/promote', handle: promoteNote },
    { method: 'GET', path: '/visibility', handle: getVisibility },
    { method: 'POST', path: '/visibility/set', handle: setVisibility }
  ] satisfies WorkplaceExperienceApiRoute[]
).map((route) => ({
  ...route,
  handle: (request: Request, context: WorkplaceExperienceApiContext) => guard(() => route.handle(request, context))
}));
