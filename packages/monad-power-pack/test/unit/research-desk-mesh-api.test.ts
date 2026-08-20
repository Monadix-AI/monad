import type { ExperienceStateStore, WorkplaceExperienceApiContext } from '@monad/sdk-atom';
import type {
  CrossRead,
  EvidenceClaim,
  ResearchNote,
  TransformationRun
} from '../../src/experiences/research-desk/domain/index.ts';

import { describe, expect, test } from 'bun:test';

import { researchDeskApi } from '../../src/experiences/research-desk/api.ts';
import { ResearchMeshStore } from '../../src/experiences/research-desk/mesh-store.ts';
import { ResearchDeskStore } from '../../src/experiences/research-desk/store.ts';
import { researchDeskWorker } from '../../src/experiences/research-desk/worker.ts';

const PROJECT = 'prj_1';
const NOW = '2026-08-19T10:00:00.000Z';

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

function fixture() {
  const sent: Array<{ sessionId: string; text: string }> = [];
  const createdSessions: string[] = [];
  const context = {
    atomPackId: 'monad-power-pack',
    experienceId: 'research-desk',
    experienceState: memoryState(),
    projectSessions: {
      list: async () => [{ id: 'ses_research', title: 'Research', state: 'active' }],
      create: async (_projectId: string, input: { title: string }) => {
        const id = `ses_${createdSessions.length + 1}`;
        createdSessions.push(input.title);
        return { id };
      },
      sendMessage: async (sessionId: string, input: { text: string }) => {
        sent.push({ sessionId, text: input.text });
      },
      listMessages: async () => ({ items: [], nextCursor: null }),
      listObservations: async () => ({ items: [], nextCursor: null }),
      runTurn: async () => ({ runId: 'run_1' }),
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
      inviteSessionMember: async () => ({}) as never,
      removeSessionMember: async () => {}
    },
    requestInteraction: async () => ({ status: 'cancelled', reason: 'unavailable' }) as const,
    workerScheduler: { schedule: async () => {}, cancel: async () => {} }
  } as unknown as WorkplaceExperienceApiContext;
  return { context, sent, createdSessions };
}

function route(method: string, path: string) {
  const found = researchDeskApi.routes.find((entry) => entry.method === method && entry.path === path);
  if (!found) throw new Error(`no route ${method} ${path}`);
  return found.handle;
}

function post(path: string, payload: unknown): Request {
  return new Request(`https://experience.test${path}`, { method: 'POST', body: JSON.stringify(payload) });
}

function get(path: string): Request {
  return new Request(`https://experience.test${path}?projectId=${PROJECT}`);
}

async function addSource(context: WorkplaceExperienceApiContext, title: string, locator: string) {
  const response = await route('POST', '/sources/add')(
    post('/sources/add', { projectId: PROJECT, kind: 'url', title, locator }),
    context
  );
  return ((await response.json()) as { source: { id: string } }).source.id;
}

function answerBlock(answer: string, sourceId: string, excerpt: string) {
  return `${answer}\n\n\`\`\`research-desk\n${JSON.stringify({
    record: 'crossread-answer',
    answer,
    citations: [{ sourceId, excerpt }]
  })}\n\`\`\``;
}

function messageEvent(sessionId: string, text: string, id: string) {
  return {
    id: `evt_${id}`,
    projectId: PROJECT,
    sessionId,
    type: 'session.message.completed',
    createdAt: NOW,
    payload: { message: { id, role: 'assistant', text, memberId: 'agent' } }
  };
}

describe('cross-read dispatch', () => {
  test('one question opens a separate session per reader and asks each to answer independently', async () => {
    const { context, sent, createdSessions } = fixture();
    const sourceId = await addSource(context, 'Vendor A pricing page', 'https://a.test/pricing');

    const response = await route('POST', '/cross-reads/start')(
      post('/cross-reads/start', {
        projectId: PROJECT,
        question: 'Do competitors price by usage?',
        sourceIds: [sourceId],
        memberIds: ['tmpl_researcher', 'tmpl_engineer']
      }),
      context
    );

    const body = (await response.json()) as { crossRead: CrossRead };
    expect(response.status).toBe(201);
    expect(body.crossRead.readings.map((reading) => reading.memberId)).toEqual(['tmpl_researcher', 'tmpl_engineer']);
    expect(new Set(body.crossRead.readings.map((reading) => reading.sessionId)).size).toBe(2);
    expect(createdSessions).toEqual(['Cross-read · Researcher', 'Cross-read · Evidence Engineer']);
    const prompts = sent.filter((message) => message.text.includes('Cross-read'));
    expect(prompts).toHaveLength(2);
    expect(prompts.every((message) => message.text.includes('Answer independently'))).toBe(true);
  });

  test('the same member twice is refused, because a second reader that is the first proves nothing', async () => {
    const { context } = fixture();

    const response = await route('POST', '/cross-reads/start')(
      post('/cross-reads/start', {
        projectId: PROJECT,
        question: 'Do competitors price by usage?',
        memberIds: ['tmpl_researcher', 'tmpl_researcher']
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'a cross-read needs distinct readers' });
  });

  test('an answer is routed to the reading whose session produced it, not to the other reader', async () => {
    const { context } = fixture();
    const sourceId = await addSource(context, 'Vendor A pricing page', 'https://a.test/pricing');
    const started = (await (
      await route('POST', '/cross-reads/start')(
        post('/cross-reads/start', {
          projectId: PROJECT,
          question: 'Do competitors price by usage?',
          sourceIds: [sourceId],
          memberIds: ['tmpl_researcher', 'tmpl_engineer']
        }),
        context
      )
    ).json()) as { crossRead: CrossRead };
    const engineerSession = started.crossRead.readings[1]?.sessionId ?? '';

    await researchDeskWorker.onEvent(
      messageEvent(
        engineerSession,
        answerBlock('No — only the infra tier did.', sourceId, 'infrastructure tier only'),
        'msg_1'
      ),
      context
    );

    const stored = await new ResearchMeshStore(context).requireCrossRead(PROJECT, started.crossRead.id);
    expect(stored.readings[0]?.state).toBe('pending');
    expect(stored.readings[1]?.state).toBe('answered');
    expect(stored.readings[1]?.answer).toBe('No — only the infra tier did.');
    expect(stored.readings[1]?.citations).toEqual([{ sourceId, excerpt: 'infrastructure tier only', locator: null }]);
  });

  test('a disagreement is ruled by a person and lands in the pool as a contested claim carrying both sides', async () => {
    const { context } = fixture();
    const sourceId = await addSource(context, 'Vendor A pricing page', 'https://a.test/pricing');
    const started = (await (
      await route('POST', '/cross-reads/start')(
        post('/cross-reads/start', {
          projectId: PROJECT,
          question: 'Do competitors price by usage?',
          sourceIds: [sourceId],
          memberIds: ['tmpl_researcher', 'tmpl_engineer']
        }),
        context
      )
    ).json()) as { crossRead: CrossRead };
    for (const [index, reading] of started.crossRead.readings.entries()) {
      await researchDeskWorker.onEvent(
        messageEvent(reading.sessionId, answerBlock(`answer ${index}`, sourceId, `excerpt ${index}`), `msg_${index}`),
        context
      );
    }
    const settled = await new ResearchMeshStore(context).requireCrossRead(PROJECT, started.crossRead.id);

    const response = await route('POST', '/cross-reads/rule')(
      post('/cross-reads/rule', {
        projectId: PROJECT,
        crossReadId: settled.id,
        expectedVersion: settled.version,
        verdict: 'disagreed',
        reason: 'they read the same page differently',
        claimText: 'Developer-tool vendors in this sample price by usage'
      }),
      context
    );

    const body = (await response.json()) as { crossRead: CrossRead; evidence: EvidenceClaim };
    expect(body.evidence.status).toBe('contested');
    expect(body.evidence.citations.map((citation) => citation.stance)).toEqual(['support', 'oppose']);
    expect(body.crossRead.verdict).toBe('disagreed');
    expect(body.crossRead.producedEvidenceId).toBe(body.evidence.id);
    expect((await new ResearchDeskStore(context).requireClaim(PROJECT, body.evidence.id)).text).toBe(
      'Developer-tool vendors in this sample price by usage'
    );
  });

  test('ruling before both readers answer is refused', async () => {
    const { context } = fixture();
    const started = (await (
      await route('POST', '/cross-reads/start')(
        post('/cross-reads/start', {
          projectId: PROJECT,
          question: 'Do competitors price by usage?',
          memberIds: ['tmpl_researcher', 'tmpl_engineer']
        }),
        context
      )
    ).json()) as { crossRead: CrossRead };

    const response = await route('POST', '/cross-reads/rule')(
      post('/cross-reads/rule', {
        projectId: PROJECT,
        crossReadId: started.crossRead.id,
        expectedVersion: started.crossRead.version,
        verdict: 'agreed',
        reason: 'looks fine',
        claimText: 'Competitors price by usage'
      }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'every reading must settle before this can be ruled on' });
  });
});

describe('transformations', () => {
  test('running a recipe dispatches to the member its role names and reports the tier in the prompt', async () => {
    const { context, sent } = fixture();

    const response = await route('POST', '/transformations/run')(
      post('/transformations/run', { projectId: PROJECT, transformationId: 'find-counterexamples' }),
      context
    );

    const body = (await response.json()) as { run: TransformationRun };
    expect(response.status).toBe(201);
    expect(body.run.memberId).toBe('tmpl_engineer');
    expect(body.run.state).toBe('running');
    expect(sent.at(-1)?.text).toContain('Find counterexamples · power tier');
  });

  test('a member cannot be pointed at a source the visibility rules keep from it', async () => {
    const { context } = fixture();
    const sourceId = await addSource(context, 'Internal CSV', 'file:///usage.csv');
    await route('POST', '/visibility/set')(
      post('/visibility/set', { projectId: PROJECT, memberId: 'tmpl_researcher', sourceIds: [] }),
      context
    );

    const response = await route('POST', '/transformations/run')(
      post('/transformations/run', { projectId: PROJECT, transformationId: 'extract-claims', sourceId }),
      context
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `this member cannot read source ${sourceId}` });
  });

  test('a run settles from the agents own report and its spend rolls up per recipe', async () => {
    const { context } = fixture();
    const started = (await (
      await route('POST', '/transformations/run')(
        post('/transformations/run', { projectId: PROJECT, transformationId: 'extract-claims' }),
        context
      )
    ).json()) as { run: TransformationRun };

    await researchDeskWorker.onEvent(
      messageEvent(
        started.run.sessionId,
        `done\n\n\`\`\`research-desk\n${JSON.stringify({ record: 'run-complete', runId: started.run.id, tokens: 900 })}\n\`\`\``,
        'msg_run'
      ),
      context
    );

    const listed = (await (await route('GET', '/transformations')(get('/transformations'), context)).json()) as {
      spend: Array<{ transformationId: string; tokens: number | null; runs: number }>;
    };
    expect(listed.spend).toEqual([
      { transformationId: 'extract-claims', label: 'Extract claims', tier: 'fast', runs: 1, tokens: 900, cost: null }
    ] as never);
  });
});

describe('notes and visibility', () => {
  test('a note is scratch paper until it is promoted, and promotion produces a claim while keeping the note', async () => {
    const { context } = fixture();
    const added = (await (
      await route('POST', '/notes/add')(
        post('/notes/add', { projectId: PROJECT, text: 'this number looks wrong' }),
        context
      )
    ).json()) as { note: ResearchNote };

    const promoted = (await (
      await route('POST', '/notes/promote')(
        post('/notes/promote', {
          projectId: PROJECT,
          noteId: added.note.id,
          expectedVersion: added.note.version,
          claimText: 'The reported median is inconsistent with the export'
        }),
        context
      )
    ).json()) as { note: ResearchNote; evidence: EvidenceClaim };

    expect(promoted.note.promotedEvidenceId).toBe(promoted.evidence.id);
    expect(promoted.evidence.status).toBe('unverified');
    const edit = await route('POST', '/notes/update')(
      post('/notes/update', {
        projectId: PROJECT,
        noteId: added.note.id,
        expectedVersion: promoted.note.version,
        text: 'reworded'
      }),
      context
    );
    expect(edit.status).toBe(400);
    expect(await edit.json()).toEqual({ error: 'a promoted note is kept as written' });
  });

  test('the visibility payload states its own scope so it cannot be quoted as network isolation', async () => {
    const { context } = fixture();
    const sourceId = await addSource(context, 'Internal CSV', 'file:///usage.csv');
    await route('POST', '/visibility/set')(
      post('/visibility/set', { projectId: PROJECT, memberId: 'tmpl_researcher', sourceIds: [] }),
      context
    );

    const body = (await (await route('GET', '/visibility')(get('/visibility'), context)).json()) as {
      matrix: Array<{ memberId: string; sourceId: string; canRead: boolean }>;
      scope: string;
    };

    expect(body.matrix).toEqual([
      { memberId: 'tmpl_researcher', sourceId, canRead: false },
      { memberId: 'tmpl_engineer', sourceId, canRead: true }
    ]);
    expect(body.scope).toBe('Controls which sources Research Desk sends to each member. It is not network isolation.');
  });
});
