import type { ExperienceStateStore, WorkplaceExperienceApiContext } from '@monad/sdk-atom';
import type {
  BlockCoverage,
  EvidenceClaim,
  Report,
  ResearchAssignment,
  SourceRef
} from '../../src/experiences/research-desk/domain/index.ts';

import { describe, expect, test } from 'bun:test';

import { researchDeskApi } from '../../src/experiences/research-desk/api.ts';
import { ResearchDeskStore } from '../../src/experiences/research-desk/store.ts';

const PROJECT = 'prj_1';

function memoryState(): ExperienceStateStore {
  const records = new Map<string, { value: unknown; version: number }>();
  return {
    get: async <T>(projectId: string, key: string) =>
      (records.get(`${projectId}:${key}`) as { value: T; version: number }) ?? null,
    list: async <T>(projectId: string, prefix: string) =>
      [...records.entries()].flatMap(([compound, record]) =>
        compound.startsWith(`${projectId}:${prefix}`)
          ? [{ key: compound.slice(projectId.length + 1), value: record.value as T, version: record.version }]
          : []
      ),
    compareAndSwap: async ({ projectId, key, expectedVersion, value }) => {
      const compound = `${projectId}:${key}`;
      const current = records.get(compound);
      if (expectedVersion === null ? current !== undefined : current?.version !== expectedVersion) return false;
      records.set(compound, { value, version: expectedVersion === null ? 0 : expectedVersion + 1 });
      return true;
    },
    compareAndDelete: async ({ projectId, key, expectedVersion }) => {
      const compound = `${projectId}:${key}`;
      if (records.get(compound)?.version !== expectedVersion) return false;
      records.delete(compound);
      return true;
    }
  };
}

function fixture({ confirmPublish = true }: { confirmPublish?: boolean } = {}) {
  const sentMessages: Array<{ sessionId: string; text: string }> = [];
  const createdSessions: Array<{ projectId: string; title: string; idempotencyKey: string }> = [];
  const invitedMembers: Array<{ sessionId: string; templateId: string }> = [];
  const runs: Array<{ sessionId: string; text: string; idempotencyKey: string }> = [];
  const interactions: unknown[] = [];
  const context = {
    atomPackId: 'monad-power-pack',
    experienceId: 'research-desk',
    experienceState: memoryState(),
    projectSessions: {
      list: async () => [{ id: 'ses_research', title: 'Research', state: 'active' }],
      create: async (projectId: string, input: { title: string; idempotencyKey: string }) => {
        createdSessions.push({ projectId, ...input });
        return { id: `ses_assignment_${createdSessions.length}` };
      },
      sendMessage: async (sessionId: string, input: { text: string }) => {
        sentMessages.push({ sessionId, text: input.text });
      },
      listMessages: async () => ({ items: [], nextCursor: null }),
      listObservations: async () => ({ items: [], nextCursor: null }),
      runTurn: async (sessionId: string, input: { text: string; idempotencyKey: string }) => {
        runs.push({ sessionId, ...input });
        return { runId: `run_${runs.length}` };
      },
      getRun: async () => null,
      pause: async () => {},
      cancel: async () => {},
      listPendingApprovals: async () => [],
      resolveApproval: async () => {}
    },
    projectMembers: {
      listTemplates: async () => [
        { id: 'tmpl_researcher', type: 'mesh-agent' as const, name: 'researcher', displayName: 'Researcher' },
        {
          id: 'tmpl_engineer',
          type: 'mesh-agent' as const,
          name: 'evidence-engineer',
          displayName: 'Evidence Engineer'
        }
      ],
      listSessionMembers: async () => [],
      inviteSessionMember: async (sessionId: string, templateId: string) => {
        invitedMembers.push({ sessionId, templateId });
        return { member: { id: `member_${templateId}` }, binding: {} } as never;
      },
      removeSessionMember: async () => {}
    },
    requestInteraction: async (request: unknown) => {
      interactions.push(request);
      return confirmPublish
        ? ({ status: 'submitted', values: {} } as const)
        : ({ status: 'cancelled', reason: 'escape' } as const);
    },
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  return { context, sentMessages, createdSessions, invitedMembers, runs, interactions };
}

function route(method: string, path: string) {
  const found = researchDeskApi.routes.find((entry) => entry.method === method && entry.path === path);
  if (!found) throw new Error(`no route ${method} ${path}`);
  return found.handle;
}

function post(path: string, payload: unknown): Request {
  return new Request(`https://experience.test${path}`, { method: 'POST', body: JSON.stringify(payload) });
}

function get(path: string, projectId = PROJECT): Request {
  return new Request(`https://experience.test${path}?projectId=${projectId}`);
}

async function seedReport(context: WorkplaceExperienceApiContext) {
  const response = await route('POST', '/report/create')(
    post('/report/create', {
      projectId: PROJECT,
      title: 'Usage-based pricing for the EU launch',
      question: 'Should a small B2B SaaS adopt usage-based pricing for its next European launch?',
      doneWhen: '5+ primary sources'
    }),
    context
  );
  return (await response.json()) as { report: Report };
}

async function seedFactualBlock(context: WorkplaceExperienceApiContext, evidenceIds: string[]) {
  const store = new ResearchDeskStore(context);
  const report = await store.requireReport(PROJECT);
  await store.putReport(
    {
      ...report,
      blocks: [
        {
          id: 'blk_landscape',
          kind: 'factual',
          heading: 'Competitive landscape',
          markdown: 'Competitors broadly adopt usage-based pricing.',
          evidenceIds,
          kindChangedByHuman: false
        }
      ],
      version: report.version + 1
    },
    report.version
  );
}

async function seedClaim(context: WorkplaceExperienceApiContext, claim: Partial<EvidenceClaim> = {}) {
  const store = new ResearchDeskStore(context);
  const { makeEvidenceClaim, addCitation } = await import('../../src/experiences/research-desk/domain/index.ts');
  const base = makeEvidenceClaim({
    id: 'evd_1',
    projectId: PROJECT,
    text: 'Competitors broadly adopt usage-based pricing',
    proposedByMemberId: 'mesh-agent:researcher',
    sessionId: 'ses_research',
    createdAt: '2026-08-13T10:00:00.000Z',
    ...claim
  });
  const contested = addCitation(
    base,
    base.version,
    {
      sourceId: 'src_a',
      excerpt: 'sample mixes infra vendors with dev tools',
      locator: null,
      stance: 'oppose',
      addedByMemberId: 'mesh-agent:evidence-engineer'
    },
    '2026-08-13T10:05:00.000Z'
  );
  await store.putClaim(contested, null);
  return await store.requireClaim(PROJECT, contested.id);
}

describe('sources', () => {
  test('adding the same locator twice returns the first source instead of creating a duplicate', async () => {
    const { context } = fixture();
    const payload = {
      projectId: PROJECT,
      kind: 'url',
      title: 'Vendor A pricing page',
      locator: 'https://a.test/pricing'
    };

    const created = await route('POST', '/sources/add')(post('/sources/add', payload), context);
    const repeated = await route('POST', '/sources/add')(post('/sources/add', payload), context);

    const first = (await created.json()) as { source: SourceRef };
    const second = (await repeated.json()) as { source: SourceRef };
    expect(created.status).toBe(201);
    expect(repeated.status).toBe(200);
    expect(second.source.id).toBe(first.source.id);
    const listed = (await (await route('GET', '/sources')(get('/sources'), context)).json()) as {
      sources: SourceRef[];
    };
    expect(listed.sources.map((source) => source.id)).toEqual([first.source.id]);
  });

  test('marking a source unreliable requires a reason and archives it', async () => {
    const { context } = fixture();
    const created = (await (
      await route('POST', '/sources/add')(
        post('/sources/add', { projectId: PROJECT, kind: 'url', title: 'Blog', locator: 'https://b.test' }),
        context
      )
    ).json()) as { source: SourceRef };

    const refused = await route('POST', '/sources/unreliable')(
      post('/sources/unreliable', { projectId: PROJECT, sourceId: created.source.id, expectedVersion: 0, reason: ' ' }),
      context
    );
    expect(refused.status).toBe(400);

    const archived = await route('POST', '/sources/unreliable')(
      post('/sources/unreliable', {
        projectId: PROJECT,
        sourceId: created.source.id,
        expectedVersion: 0,
        reason: 'vendor-sponsored'
      }),
      context
    );
    const body = (await archived.json()) as { source: SourceRef };
    expect(body.source.status).toBe('archived');
    expect(body.source.statusReason).toBe('vendor-sponsored');
  });

  test('an unknown source answers 404 rather than a generic failure', async () => {
    const { context } = fixture();

    const response = await route('POST', '/sources/inspect')(
      post('/sources/inspect', { projectId: PROJECT, sourceId: 'src_missing' }),
      context
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'source not found: src_missing' });
  });
});

describe('evidence decisions', () => {
  test('a decision without a reason is refused before anything is written', async () => {
    const { context } = fixture();
    await seedReport(context);
    const claim = await seedClaim(context);

    const response = await route('POST', '/evidence/decide')(
      post('/evidence/decide', {
        projectId: PROJECT,
        evidenceId: claim.id,
        expectedVersion: claim.version,
        status: 'accepted',
        reason: '   '
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'a decision requires a reason' });
    expect((await new ResearchDeskStore(context).requireClaim(PROJECT, claim.id)).status).toBe('contested');
  });

  test('accepting a contested claim returns the updated claim and the recomputed coverage in one response', async () => {
    const { context } = fixture();
    await seedReport(context);
    const claim = await seedClaim(context);
    await seedFactualBlock(context, [claim.id]);

    const response = await route('POST', '/evidence/decide')(
      post('/evidence/decide', {
        projectId: PROJECT,
        evidenceId: claim.id,
        expectedVersion: claim.version,
        status: 'accepted',
        editedText: 'Developer-tool vendors in this sample more often adopt usage-based pricing',
        reason: 'narrowed to the comparable subset'
      }),
      context
    );

    const body = (await response.json()) as { evidence: EvidenceClaim; coverage: BlockCoverage[] };
    expect(response.status).toBe(200);
    expect(body.evidence.status).toBe('accepted');
    expect(body.evidence.text).toBe('Developer-tool vendors in this sample more often adopt usage-based pricing');
    expect(body.evidence.decisionReason).toBe('narrowed to the comparable subset');
    expect(body.coverage).toEqual([
      {
        blockId: 'blk_landscape',
        heading: 'Competitive landscape',
        kind: 'factual',
        accepted: 1,
        contested: 0,
        missing: 0
      }
    ]);
  });

  test('a stale expected version answers 409 so a second window cannot overwrite the first ruling', async () => {
    const { context } = fixture();
    await seedReport(context);
    const claim = await seedClaim(context);
    await route('POST', '/evidence/decide')(
      post('/evidence/decide', {
        projectId: PROJECT,
        evidenceId: claim.id,
        expectedVersion: claim.version,
        status: 'accepted',
        reason: 'first ruling'
      }),
      context
    );

    const stale = await route('POST', '/evidence/decide')(
      post('/evidence/decide', {
        projectId: PROJECT,
        evidenceId: claim.id,
        expectedVersion: claim.version,
        status: 'rejected',
        reason: 'second ruling'
      }),
      context
    );

    expect(stale.status).toBe(409);
    expect((await new ResearchDeskStore(context).requireClaim(PROJECT, claim.id)).decisionReason).toBe('first ruling');
  });

  test('re-running a claim with no verification run is refused', async () => {
    const { context, sentMessages } = fixture();
    await seedReport(context);
    const claim = await seedClaim(context);

    const response = await route('POST', '/evidence/rerun')(
      post('/evidence/rerun', { projectId: PROJECT, evidenceId: claim.id }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'this claim has no verification run to repeat' });
    expect(sentMessages).toEqual([]);
  });
});

describe('mesh dispatch', () => {
  test('challenging a claim creates one bounded Evidence Engineer run and returns its durable assignment', async () => {
    const { context, createdSessions, invitedMembers, runs } = fixture();
    await seedReport(context);
    const claim = await seedClaim(context);
    await seedFactualBlock(context, [claim.id]);

    const first = await route('POST', '/evidence/challenge')(
      post('/evidence/challenge', { projectId: PROJECT, evidenceId: claim.id }),
      context
    );
    const firstBody = (await first.json()) as { assignment: ResearchAssignment };
    const repeated = await route('POST', '/evidence/challenge')(
      post('/evidence/challenge', { projectId: PROJECT, evidenceId: claim.id }),
      context
    );
    const repeatedBody = (await repeated.json()) as { assignment: ResearchAssignment };

    expect({ firstStatus: first.status, repeatedStatus: repeated.status }).toEqual({
      firstStatus: 201,
      repeatedStatus: 200
    });
    expect({
      role: firstBody.assignment.role,
      state: firstBody.assignment.state,
      targetClaimId: firstBody.assignment.targetClaimId,
      targetBlockId: firstBody.assignment.targetBlockId,
      memberId: firstBody.assignment.memberId,
      sessionId: firstBody.assignment.sessionId,
      runId: firstBody.assignment.runId,
      contextReceipt: firstBody.assignment.contextReceipt
    }).toEqual({
      role: 'evidence-engineer',
      state: 'running',
      targetClaimId: claim.id,
      targetBlockId: null,
      memberId: 'member_tmpl_engineer',
      sessionId: 'ses_assignment_1',
      runId: 'run_1',
      contextReceipt: {
        brief:
          'Usage-based pricing for the EU launch: Should a small B2B SaaS adopt usage-based pricing for its next European launch? Done when: 5+ primary sources',
        sourceIds: ['src_a'],
        claimIds: [claim.id],
        blockIds: ['blk_landscape']
      }
    });
    expect(repeatedBody.assignment).toEqual(firstBody.assignment);
    expect(createdSessions).toEqual([
      {
        projectId: PROJECT,
        title: 'Research · evidence engineer',
        idempotencyKey: `research-desk:assignment:${firstBody.assignment.id}`
      }
    ]);
    expect(invitedMembers).toEqual([{ sessionId: 'ses_assignment_1', templateId: 'tmpl_engineer' }]);
    expect(runs.map(({ sessionId, idempotencyKey }) => ({ sessionId, idempotencyKey }))).toEqual([
      { sessionId: 'ses_assignment_1', idempotencyKey: `research-desk:run:${firstBody.assignment.id}` }
    ]);
    expect(runs[0]?.text).toContain(
      `"claimId":"${claim.id}","assignmentId":"${firstBody.assignment.id}","kind":"challenge"`
    );
    const listed = (await (await route('GET', '/assignments')(get('/assignments'), context)).json()) as {
      assignments: ResearchAssignment[];
    };
    expect(listed.assignments).toEqual([firstBody.assignment]);
  });

  test('a blocked report dispatch targets its exact missing-evidence context to the Researcher', async () => {
    const { context, invitedMembers, runs } = fixture();
    await seedReport(context);
    const claim = await seedClaim(context);
    await seedFactualBlock(context, [claim.id]);

    const response = await route('POST', '/report/blocks/dispatch')(
      post('/report/blocks/dispatch', { projectId: PROJECT, blockId: 'blk_landscape' }),
      context
    );
    const body = (await response.json()) as { assignment: ResearchAssignment };

    expect(response.status).toBe(201);
    expect({
      role: body.assignment.role,
      state: body.assignment.state,
      targetClaimId: body.assignment.targetClaimId,
      targetBlockId: body.assignment.targetBlockId,
      contextReceipt: body.assignment.contextReceipt
    }).toEqual({
      role: 'researcher',
      state: 'running',
      targetClaimId: null,
      targetBlockId: 'blk_landscape',
      contextReceipt: {
        brief:
          'Usage-based pricing for the EU launch: Should a small B2B SaaS adopt usage-based pricing for its next European launch? Done when: 5+ primary sources',
        sourceIds: ['src_a'],
        claimIds: [claim.id],
        blockIds: ['blk_landscape']
      }
    });
    expect(invitedMembers).toEqual([{ sessionId: 'ses_assignment_1', templateId: 'tmpl_researcher' }]);
    expect(runs[0]?.text).toContain(`Assignment ID: ${body.assignment.id}`);
    expect(runs[0]?.text).toContain(`Existing claim IDs: ${claim.id}`);
  });
});

describe('publish gate', () => {
  test('a factual block without accepted evidence blocks the publish and names it, without asking for approval', async () => {
    const { context, interactions } = fixture();
    const { report } = await seedReport(context);
    const claim = await seedClaim(context);
    await seedFactualBlock(context, [claim.id]);

    const response = await route('POST', '/report/publish')(
      post('/report/publish', { projectId: PROJECT, expectedVersion: report.version + 1 }),
      context
    );

    const body = (await response.json()) as { error: string; blockedBlocks: BlockCoverage[] };
    expect(response.status).toBe(409);
    expect(body.error).toBe('cannot publish: 1 factual blocks have no accepted evidence');
    expect(body.blockedBlocks).toEqual([
      {
        blockId: 'blk_landscape',
        heading: 'Competitive landscape',
        kind: 'factual',
        accepted: 0,
        contested: 1,
        missing: 1
      }
    ]);
    expect(interactions).toEqual([]);
    expect((await new ResearchDeskStore(context).requireReport(PROJECT)).state).toBe('draft');
  });

  test('publishing an unblocked report asks for approval and returns the manifest of every cited source', async () => {
    const { context, interactions } = fixture();
    await seedReport(context);
    const store = new ResearchDeskStore(context);
    const source = (await (
      await route('POST', '/sources/add')(
        post('/sources/add', {
          projectId: PROJECT,
          kind: 'url',
          title: 'Vendor A pricing page',
          locator: 'https://a.test/pricing'
        }),
        context
      )
    ).json()) as { source: SourceRef };
    const { makeEvidenceClaim, addCitation, decideClaim } = await import(
      '../../src/experiences/research-desk/domain/index.ts'
    );
    const cited = decideClaim(
      addCitation(
        makeEvidenceClaim({
          id: 'evd_ok',
          projectId: PROJECT,
          text: 'Median seat price fell 12% year over year',
          proposedByMemberId: 'mesh-agent:evidence-engineer',
          sessionId: 'ses_research'
        }),
        0,
        {
          sourceId: source.source.id,
          excerpt: 'list price table',
          locator: 'p.1',
          stance: 'support',
          addedByMemberId: 'mesh-agent:evidence-engineer'
        },
        '2026-08-13T10:00:00.000Z'
      ),
      1,
      { status: 'accepted', reason: 'recomputed from the export' },
      '2026-08-13T10:10:00.000Z'
    );
    await store.putClaim(cited, null);
    await seedFactualBlock(context, [cited.id]);
    const current = await store.requireReport(PROJECT);

    const response = await route('POST', '/report/publish')(
      post('/report/publish', { projectId: PROJECT, expectedVersion: current.version }),
      context
    );

    const body = (await response.json()) as {
      published: boolean;
      report: Report;
      manifest: Array<{ sourceId: string; fingerprint: string | null }>;
    };
    expect(response.status).toBe(200);
    expect(body.published).toBe(true);
    expect(body.report.state).toBe('published');
    expect(interactions).toHaveLength(1);
    expect(body.manifest).toEqual([
      {
        sourceId: source.source.id,
        title: 'Vendor A pricing page',
        locator: 'https://a.test/pricing',
        capturedAt: null,
        fingerprint: null,
        status: 'queued'
      }
    ] as never);
  });

  test('declining the approval leaves the report a draft', async () => {
    const { context } = fixture({ confirmPublish: false });
    await seedReport(context);
    const store = new ResearchDeskStore(context);
    const { makeEvidenceClaim, decideClaim } = await import('../../src/experiences/research-desk/domain/index.ts');
    const accepted = decideClaim(
      makeEvidenceClaim({
        id: 'evd_ok',
        projectId: PROJECT,
        text: 'Accepted claim',
        proposedByMemberId: 'mesh-agent:researcher',
        sessionId: 'ses_research'
      }),
      0,
      { status: 'accepted', reason: 'checked' },
      '2026-08-13T10:10:00.000Z'
    );
    await store.putClaim(accepted, null);
    await seedFactualBlock(context, [accepted.id]);
    const current = await store.requireReport(PROJECT);

    const response = await route('POST', '/report/publish')(
      post('/report/publish', { projectId: PROJECT, expectedVersion: current.version }),
      context
    );

    expect((await response.json()) as { published: boolean }).toMatchObject({ published: false });
    expect((await store.requireReport(PROJECT)).state).toBe('draft');
  });
});

describe('overview', () => {
  test('overview reports no cost rather than a zero the operator would read as free', async () => {
    const { context } = fixture();
    await seedReport(context);
    await seedClaim(context);

    const response = await route('GET', '/overview')(get('/overview'), context);

    const body = (await response.json()) as {
      overview: {
        stage: string;
        usage: { tokens: number | null; cost: unknown };
        counts: { sources: number; claims: number; needsYou: number };
        members: Array<{ role: string }>;
      };
    };
    expect(body.overview.usage).toEqual({ tokens: null, cost: null });
    expect(body.overview.stage).toBe('verifying');
    expect(body.overview.counts).toEqual({ sources: 0, claims: 1, needsYou: 1 });
    expect(body.overview.members.map((member) => member.role)).toEqual(['researcher', 'evidence-engineer']);
  });
});
