import type { ExperienceStateStore, WorkplaceExperienceApiContext } from '@monad/sdk-atom';

import { afterEach, describe, expect, test } from 'bun:test';

import { captureSource, decideClaim, makeSourceRef } from '../../src/experiences/research-desk/domain/index.ts';
import { parsePayloads } from '../../src/experiences/research-desk/ingest.ts';
import { ResearchDeskStore } from '../../src/experiences/research-desk/store.ts';
import { researchDeskWorker } from '../../src/experiences/research-desk/worker.ts';

const PROJECT = 'prj_1';
const NOW = '2026-08-13T10:00:00.000Z';
const LATER = '2026-08-13T16:00:00.000Z';
const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

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
    compareAndDelete: async () => true
  };
}

function fixture() {
  const scheduled: Array<{ key: string; runAt: string }> = [];
  const context = {
    atomPackId: 'monad-power-pack',
    experienceId: 'research-desk',
    experienceState: memoryState(),
    projectSessions: { list: async () => [], listMessages: async () => ({ items: [], nextCursor: null }) },
    projectMembers: { listTemplates: async () => [] },
    requestInteraction: async () => ({ status: 'cancelled', reason: 'unavailable' }) as const,
    workerScheduler: {
      schedule: async (_projectId: string, input: { key: string; runAt: string }) => {
        scheduled.push(input);
      },
      cancel: async () => {}
    }
  } as unknown as WorkplaceExperienceApiContext;
  return { context, scheduled };
}

function messageEvent(text: string, id = 'msg_1') {
  return {
    id: `evt_${id}`,
    projectId: PROJECT,
    sessionId: 'ses_research',
    type: 'session.message.completed',
    createdAt: NOW,
    payload: { message: { id, role: 'assistant', text, memberId: 'mesh-agent:researcher' } }
  };
}

const SOURCE_BLOCK = `Here is what I found.

\`\`\`research-desk
{"record":"source","kind":"url","type":"primary","title":"Vendor A pricing page","locator":"https://a.test/pricing","fingerprint":"fp_3f9a"}
\`\`\``;

const CLAIM_BLOCK = `\`\`\`research-desk
{"record":"claim","text":"Competitors broadly adopt usage-based pricing","citations":[{"sourceLocator":"https://a.test/pricing","excerpt":"moving to consumption pricing","stance":"support"}]}
\`\`\``;

describe('parsing agent output', () => {
  test('a fenced block becomes a payload and surrounding prose is ignored', () => {
    expect(parsePayloads(SOURCE_BLOCK)).toEqual([
      {
        record: 'source',
        kind: 'url',
        type: 'primary',
        title: 'Vendor A pricing page',
        locator: 'https://a.test/pricing',
        fingerprint: 'fp_3f9a'
      }
    ]);
  });

  test('a malformed block is left as transcript text instead of failing the turn', () => {
    expect(parsePayloads('```research-desk\n{not json\n```')).toEqual([]);
    expect(parsePayloads('```research-desk\n{"record":"unknown"}\n```')).toEqual([]);
  });
});

describe('ingesting agent messages', () => {
  test('a source block becomes a captured source and a later claim cites it by locator', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);

    await researchDeskWorker.onEvent(messageEvent(SOURCE_BLOCK), context);
    await researchDeskWorker.onEvent(messageEvent(CLAIM_BLOCK, 'msg_2'), context);

    const [source] = await store.listSources(PROJECT);
    const [claim] = await store.listClaims(PROJECT);
    expect(source?.status).toBe('available');
    expect(source?.fingerprint).toBe('fp_3f9a');
    expect(source?.type).toBe('primary');
    expect(claim?.status).toBe('supported');
    expect(claim?.citations).toEqual([
      {
        sourceId: source?.id,
        excerpt: 'moving to consumption pricing',
        locator: null,
        stance: 'support',
        addedByMemberId: 'mesh-agent:researcher',
        addedAt: NOW
      }
    ]);
  });

  test('a source the agent could not read keeps its reason and stays visible', async () => {
    const { context } = fixture();
    const blocked = `\`\`\`research-desk
{"record":"source","kind":"url","title":"Analyst report","locator":"https://paywall.test/x","status":"blocked","statusReason":"login required"}
\`\`\``;

    await researchDeskWorker.onEvent(messageEvent(blocked), context);

    const [source] = await new ResearchDeskStore(context).listSources(PROJECT);
    expect(source?.status).toBe('blocked');
    expect(source?.statusReason).toBe('login required');
    expect(source?.fingerprint).toBeNull();
  });

  test('an agent repeating a claim does not overwrite the ruling already recorded against it', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);
    await researchDeskWorker.onEvent(messageEvent(SOURCE_BLOCK), context);
    await researchDeskWorker.onEvent(messageEvent(CLAIM_BLOCK, 'msg_2'), context);
    const [claim] = await store.listClaims(PROJECT);
    if (!claim) throw new Error('expected an ingested claim');
    await store.putClaim(
      decideClaim(claim, claim.version, { status: 'rejected', reason: 'sample not comparable' }, NOW),
      claim.version
    );

    await researchDeskWorker.onEvent(messageEvent(CLAIM_BLOCK, 'msg_3'), context);

    const [after] = await store.listClaims(PROJECT);
    expect(after?.status).toBe('rejected');
    expect(after?.decisionReason).toBe('sample not comparable');
  });

  test('a user message is not ingested', async () => {
    const { context } = fixture();
    const event = messageEvent(SOURCE_BLOCK);

    await researchDeskWorker.onEvent(
      { ...event, payload: { message: { id: 'msg_u', role: 'user', text: SOURCE_BLOCK } } },
      context
    );

    expect(await new ResearchDeskStore(context).listSources(PROJECT)).toEqual([]);
  });
});

describe('rechecking sources', () => {
  test('an unreachable source is flagged without replacing the snapshot the citations point at', async () => {
    const { context, scheduled } = fixture();
    const store = new ResearchDeskStore(context);
    const captured = captureSource(
      makeSourceRef({
        id: 'src_a',
        projectId: PROJECT,
        kind: 'url',
        title: 'Vendor A pricing page',
        locator: 'https://a.test/pricing',
        sessionId: 'ses_research',
        capturedByMemberId: 'mesh-agent:researcher',
        createdAt: NOW
      }),
      0,
      { fingerprint: 'fp_3f9a' },
      NOW
    );
    await store.putSource(captured, null);
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

    await researchDeskWorker.onWake({ projectId: PROJECT, key: 'source-recheck', now: LATER }, context);

    const [source] = await store.listSources(PROJECT);
    expect(source?.status).toBe('unreachable');
    expect(source?.statusReason).toBe('the source answered 404');
    expect(source?.fingerprint).toBe('fp_3f9a');
    expect(source?.capturedAt).toBe(NOW);
    expect(source?.recheckedAt).toBe(LATER);
    expect(scheduled.at(-1)?.key).toBe('source-recheck');
  });

  test('a source that still resolves is left untouched', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);
    const captured = captureSource(
      makeSourceRef({
        id: 'src_a',
        projectId: PROJECT,
        kind: 'url',
        title: 'Vendor A pricing page',
        locator: 'https://a.test/pricing',
        sessionId: 'ses_research',
        capturedByMemberId: 'mesh-agent:researcher',
        createdAt: NOW
      }),
      0,
      { fingerprint: 'fp_3f9a' },
      NOW
    );
    const stored = await store.putSource(captured, null);
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

    await researchDeskWorker.onWake({ projectId: PROJECT, key: 'source-recheck', now: LATER }, context);

    expect(await store.requireSource(PROJECT, 'src_a')).toEqual(stored);
  });

  test('an unrelated wake key does no work', async () => {
    const { context, scheduled } = fixture();
    globalThis.fetch = (async () => {
      throw new Error('recheck must not run for another key');
    }) as typeof fetch;

    await researchDeskWorker.onWake({ projectId: PROJECT, key: 'other', now: LATER }, context);

    expect(scheduled).toEqual([]);
  });
});
