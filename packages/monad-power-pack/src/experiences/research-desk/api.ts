import type { WorkplaceExperienceApi, WorkplaceExperienceApiContext } from '@monad/sdk-atom';
import type { EvidenceClaim, Report } from './domain/index.ts';

import { z } from 'zod';

import {
  archiveSource,
  decideClaim,
  makeReport,
  makeSourceRef,
  manifestEntries,
  PublishBlockedError,
  patchBlock,
  publishReport,
  REPORT_BLOCK_KINDS,
  reportCoverage,
  SOURCE_KINDS,
  SOURCE_TYPES
} from './domain/index.ts';
import { NotFoundError, ResearchDeskStore, researchDeskId } from './store.ts';

const RESEARCH_SESSION_TITLE = 'Research';

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function statusFor(error: Error): number {
  if (error instanceof NotFoundError) return 404;
  if (error.message.includes('version conflict')) return 409;
  return 400;
}

/** Business failures answer in the shape the pane already renders. A publish refused by the gate is
 *  not an error the operator has to interpret — it is the list of blocks to go fix. */
async function guard(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof PublishBlockedError) {
      return json({ error: error.message, blockedBlocks: error.blockers }, 409);
    }
    if (error instanceof Error) return json({ error: error.message }, statusFor(error));
    throw error;
  }
}

async function body<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  return schema.parse(await request.json());
}

function projectIdOf(request: Request): string {
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) throw new Error('projectId is required');
  return projectId;
}

function now(): string {
  return new Date().toISOString();
}

async function researchSessionId(projectId: string, context: WorkplaceExperienceApiContext): Promise<string> {
  const sessions = await context.projectSessions.list(projectId);
  const existing = sessions.find((session) => session.title === RESEARCH_SESSION_TITLE);
  if (existing) return existing.id;
  const created = await context.projectSessions.create(projectId, {
    title: RESEARCH_SESSION_TITLE,
    idempotencyKey: `research-desk:${projectId}:research`
  });
  return created.id;
}

export type ResearchStage = 'collecting' | 'verifying' | 'synthesizing' | 'review' | 'published';

/** Where the work stands, read off the material rather than stored as a mode the operator has to keep
 *  in sync by hand. */
export function stageOf(claims: readonly EvidenceClaim[], report: Report | null): ResearchStage {
  if (report?.state === 'published') return 'published';
  if (report?.state === 'review') return 'review';
  if (claims.some((claim) => claim.status === 'contested' || claim.status === 'unverified')) return 'verifying';
  if (report && report.blocks.length > 0) return 'synthesizing';
  return claims.length > 0 ? 'verifying' : 'collecting';
}

export function needsYouCount(claims: readonly EvidenceClaim[]): number {
  return claims.filter((claim) => claim.status === 'contested' && claim.decidedBy === null).length;
}

const MEMBER_ROLES: Record<string, 'researcher' | 'evidence-engineer'> = {
  researcher: 'researcher',
  'evidence-engineer': 'evidence-engineer'
};

async function getOverview(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const projectId = projectIdOf(request);
    const store = new ResearchDeskStore(context);
    const [sources, claims, report, templates] = await Promise.all([
      store.listSources(projectId),
      store.listClaims(projectId),
      store.getReport(projectId),
      context.projectMembers.listTemplates(projectId)
    ]);
    return json({
      overview: {
        projectId,
        report: report
          ? {
              id: report.id,
              title: report.title,
              question: report.question,
              doneWhen: report.doneWhen,
              state: report.state,
              revision: report.revision
            }
          : null,
        stage: stageOf(claims, report),
        members: templates.map((template) => ({
          memberId: template.id,
          role: MEMBER_ROLES[template.name] ?? 'other',
          displayName: template.displayName ?? template.name,
          sessionId: null
        })),
        // No scoped per-project usage read exists yet, so both stay null rather than reporting a
        // zero the operator would read as "this cost nothing".
        usage: { tokens: null, cost: null },
        counts: { sources: sources.length, claims: claims.length, needsYou: needsYouCount(claims) }
      }
    });
  });
}

async function listSources(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => json({ sources: await new ResearchDeskStore(context).listSources(projectIdOf(request)) }));
}

const addSourceSchema = z.object({
  projectId: z.string().min(1),
  kind: z.enum(SOURCE_KINDS),
  title: z.string().min(1).max(500),
  locator: z.string().min(1).max(4_000),
  type: z.enum(SOURCE_TYPES).optional()
});

async function addSource(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, addSourceSchema);
    const store = new ResearchDeskStore(context);
    const sessionId = await researchSessionId(input.projectId, context);
    const source = makeSourceRef({
      id: researchDeskId('src', input.projectId, `${input.kind}:${input.locator}`),
      projectId: input.projectId,
      kind: input.kind,
      type: input.type,
      title: input.title,
      locator: input.locator,
      sessionId,
      capturedByMemberId: 'human',
      createdAt: now()
    });
    const existing = await store.getSource(input.projectId, source.id);
    if (existing) return json({ source: existing }, 200);
    return json({ source: await store.putSource(source, null) }, 201);
  });
}

const inspectSchema = z.object({ projectId: z.string().min(1), sourceId: z.string().min(1) });

async function inspectSource(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, inspectSchema);
    const store = new ResearchDeskStore(context);
    const source = await store.requireSource(input.projectId, input.sourceId);
    await context.projectSessions.sendMessage(source.sessionId, {
      text: `Inspect this source and extract candidate claims with exact locators: ${source.locator}`,
      idempotencyKey: `research-desk:inspect:${source.id}:${source.version}`
    });
    return json({ source });
  });
}

const unreliableSchema = z.object({
  projectId: z.string().min(1),
  sourceId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().min(1).max(2_000)
});

async function markUnreliable(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, unreliableSchema);
    const store = new ResearchDeskStore(context);
    const source = await store.requireSource(input.projectId, input.sourceId);
    const archived = archiveSource(source, input.expectedVersion, input.reason, now());
    return json({ source: await store.putSource(archived, input.expectedVersion) });
  });
}

async function listEvidence(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => json({ evidence: await new ResearchDeskStore(context).listClaims(projectIdOf(request)) }));
}

const decideSchema = z.object({
  projectId: z.string().min(1),
  evidenceId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  status: z.enum(['accepted', 'rejected']),
  reason: z.string().max(4_000),
  editedText: z.string().max(4_000).optional()
});

async function decideEvidence(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, decideSchema);
    const store = new ResearchDeskStore(context);
    const claim = await store.requireClaim(input.projectId, input.evidenceId);
    const decided = decideClaim(
      claim,
      input.expectedVersion,
      { status: input.status, reason: input.reason, editedText: input.editedText },
      now()
    );
    const saved = await store.putClaim(decided, input.expectedVersion);
    const report = await store.getReport(input.projectId);
    const claims = await store.claimsById(input.projectId);
    return json({ evidence: saved, coverage: report ? reportCoverage(report, claims) : [] });
  });
}

const rerunSchema = z.object({ projectId: z.string().min(1), evidenceId: z.string().min(1) });

async function rerunEvidence(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, rerunSchema);
    const store = new ResearchDeskStore(context);
    const claim = await store.requireClaim(input.projectId, input.evidenceId);
    const derivation = claim.derivations.at(-1);
    if (!derivation) throw new Error('this claim has no verification run to repeat');
    await context.projectSessions.sendMessage(claim.sessionId, {
      text: `Re-run ${derivation.script} against inputs ${derivation.inputFingerprints.join(', ')} and report whether the output still matches ${derivation.artifactPath}.`,
      idempotencyKey: `research-desk:rerun:${claim.id}:${claim.derivations.length}`
    });
    return json({ evidence: claim });
  });
}

async function getReport(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const projectId = projectIdOf(request);
    const store = new ResearchDeskStore(context);
    const [report, claims] = await Promise.all([store.getReport(projectId), store.claimsById(projectId)]);
    return json({ report, coverage: report ? reportCoverage(report, claims) : [] });
  });
}

const patchBlockSchema = z.object({
  projectId: z.string().min(1),
  blockId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative(),
  patch: z.object({
    kind: z.enum(REPORT_BLOCK_KINDS).optional(),
    heading: z.string().min(1).max(500).optional(),
    markdown: z.string().max(100_000).optional(),
    evidenceIds: z.array(z.string().min(1)).max(200).optional()
  })
});

async function patchReportBlock(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, patchBlockSchema);
    const store = new ResearchDeskStore(context);
    const report = await store.requireReport(input.projectId);
    const patched = patchBlock(report, input.expectedVersion, input.blockId, input.patch, 'human', now());
    const saved = await store.putReport(patched, input.expectedVersion);
    return json({ report: saved, coverage: reportCoverage(saved, await store.claimsById(input.projectId)) });
  });
}

const publishSchema = z.object({ projectId: z.string().min(1), expectedVersion: z.number().int().nonnegative() });

async function publish(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, publishSchema);
    const store = new ResearchDeskStore(context);
    const [report, claims, sources] = await Promise.all([
      store.requireReport(input.projectId),
      store.claimsById(input.projectId),
      store.listSources(input.projectId)
    ]);
    // Throws PublishBlockedError before anything is written or approved, so a refused publish leaves
    // the draft exactly as it was.
    const published = publishReport(report, input.expectedVersion, claims, now());
    const confirmation = await context.requestInteraction({
      type: 'confirm',
      title: 'Publish this report revision?',
      description: `Creates an immutable revision on this machine. Nothing is sent anywhere. ${report.title} · revision ${report.revision} · ${report.blocks.length} blocks`,
      confirmLabel: 'Publish revision'
    });
    // `published` discriminates the two 200s: the gate passed but the operator declined the approval,
    // which must not read as a publish.
    if (confirmation.status !== 'submitted') return json({ published: false, report, manifest: [] });
    const saved = await store.putReport(published, input.expectedVersion);
    const manifest = manifestEntries(saved, claims, new Map(sources.map((source) => [source.id, source])));
    return json({ published: true, report: saved, manifest });
  });
}

const createReportSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(500),
  question: z.string().min(1).max(4_000),
  doneWhen: z.string().min(1).max(4_000).optional()
});

async function createReport(request: Request, context: WorkplaceExperienceApiContext): Promise<Response> {
  return guard(async () => {
    const input = await body(request, createReportSchema);
    const store = new ResearchDeskStore(context);
    const existing = await store.getReport(input.projectId);
    if (existing)
      return json({ report: existing, coverage: reportCoverage(existing, await store.claimsById(input.projectId)) });
    const sessionId = await researchSessionId(input.projectId, context);
    const report = makeReport({
      id: researchDeskId('rep', input.projectId, input.question),
      projectId: input.projectId,
      title: input.title,
      question: input.question,
      doneWhen: input.doneWhen ?? null,
      sessionId,
      createdAt: now()
    });
    return json({ report: await store.putReport(report, null), coverage: [] }, 201);
  });
}

export const researchDeskApi: WorkplaceExperienceApi = {
  experienceId: 'research-desk',
  routes: [
    { method: 'GET', path: '/overview', handle: getOverview },
    { method: 'GET', path: '/sources', handle: listSources },
    { method: 'POST', path: '/sources/add', handle: addSource },
    { method: 'POST', path: '/sources/inspect', handle: inspectSource },
    { method: 'POST', path: '/sources/unreliable', handle: markUnreliable },
    { method: 'GET', path: '/evidence', handle: listEvidence },
    { method: 'POST', path: '/evidence/decide', handle: decideEvidence },
    { method: 'POST', path: '/evidence/rerun', handle: rerunEvidence },
    { method: 'GET', path: '/report', handle: getReport },
    { method: 'POST', path: '/report/create', handle: createReport },
    { method: 'POST', path: '/report/blocks/patch', handle: patchReportBlock },
    { method: 'POST', path: '/report/publish', handle: publish }
  ]
};
