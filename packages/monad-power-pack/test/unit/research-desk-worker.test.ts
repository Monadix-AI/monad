import type { ExperienceStateStore, WorkplaceExperienceApiContext } from '@monad/sdk-atom';

import { afterEach, describe, expect, test } from 'bun:test';

import {
  captureSource,
  decideClaim,
  makeReport,
  makeResearchAssignment,
  makeSourceRef,
  reportCoverage,
  upsertBlock
} from '../../src/experiences/research-desk/domain/index.ts';
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

function memoryState(
  beforeSwap: (input: { key: string; expectedVersion: number | null }) => Promise<void> = async () => {}
): ExperienceStateStore {
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
      await beforeSwap({ key, expectedVersion });
      const compound = `${projectId}:${key}`;
      const current = records.get(compound);
      if (expectedVersion === null ? current !== undefined : current?.version !== expectedVersion) return false;
      records.set(compound, { value, version: expectedVersion === null ? 0 : expectedVersion + 1 });
      return true;
    },
    compareAndDelete: async () => true
  };
}

function fixture(experienceState = memoryState()) {
  const scheduled: Array<{ key: string; runAt: string }> = [];
  const context = {
    atomPackId: 'monad-power-pack',
    experienceId: 'research-desk',
    experienceState,
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

function messageEvent(text: string, id = 'msg_1', memberId = 'mesh-agent:researcher') {
  return {
    id: `evt_${id}`,
    projectId: PROJECT,
    sessionId: 'ses_research',
    type: 'session.message.completed',
    createdAt: NOW,
    payload: { message: { id, role: 'assistant', text, memberId } }
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

  test('a second mesh member appends an opposing contribution with worker-owned provenance', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);
    await researchDeskWorker.onEvent(messageEvent(SOURCE_BLOCK), context);
    await researchDeskWorker.onEvent(messageEvent(CLAIM_BLOCK, 'msg_claim'), context);
    const [before] = await store.listClaims(PROJECT);
    if (!before) throw new Error('expected an ingested claim');
    const contribution = `\`\`\`research-desk
{"record":"claim-contribution","id":"ctb_oppose","claimId":"${before.id}","kind":"citation","payload":{"sourceLocator":"https://a.test/pricing","excerpt":"the comparable cohort kept seat pricing","stance":"oppose"},"memberId":"spoofed","sessionId":"spoofed","messageId":"spoofed"}
\`\`\``;

    await researchDeskWorker.onEvent(messageEvent(contribution, 'msg_verify', 'mesh-agent:evidence-engineer'), context);

    const after = await store.requireClaim(PROJECT, before.id);
    expect(after.status).toBe('contested');
    expect(after.contributions).toEqual([
      {
        id: 'ctb_oppose',
        claimId: before.id,
        assignmentId: null,
        memberId: 'mesh-agent:evidence-engineer',
        sessionId: 'ses_research',
        messageId: 'msg_verify',
        kind: 'citation',
        payload: {
          sourceId: after.citations[0]?.sourceId,
          excerpt: 'the comparable cohort kept seat pricing',
          locator: null,
          stance: 'oppose'
        },
        createdAt: NOW
      }
    ]);
    expect(after.citations.at(-1)?.addedByMemberId).toBe('mesh-agent:evidence-engineer');
  });

  test('replaying the same contribution leaves the claim byte-for-byte unchanged', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);
    await researchDeskWorker.onEvent(messageEvent(CLAIM_BLOCK, 'msg_claim'), context);
    const [claim] = await store.listClaims(PROJECT);
    if (!claim) throw new Error('expected an ingested claim');
    const contribution = `\`\`\`research-desk
{"record":"claim-contribution","id":"ctb_once","claimId":"${claim.id}","kind":"challenge","payload":{"reason":"sample mismatch"}}
\`\`\``;
    await researchDeskWorker.onEvent(messageEvent(contribution, 'msg_verify'), context);
    const once = await store.requireClaim(PROJECT, claim.id);

    await researchDeskWorker.onEvent(messageEvent(contribution, 'msg_replayed'), context);

    expect(await store.requireClaim(PROJECT, claim.id)).toEqual(once);
  });

  test('concurrent distinct contributions merge after a compare-and-swap conflict', async () => {
    let arrivals = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const state = memoryState(async ({ key, expectedVersion }) => {
      if (!key.startsWith('evidence/') || expectedVersion !== 0) return;
      arrivals += 1;
      if (arrivals === 2) release?.();
      await gate;
    });
    const { context } = fixture(state);
    const store = new ResearchDeskStore(context);
    await researchDeskWorker.onEvent(messageEvent(CLAIM_BLOCK, 'msg_claim'), context);
    const [claim] = await store.listClaims(PROJECT);
    if (!claim) throw new Error('expected an ingested claim');
    const block = (id: string, reason: string) => `\`\`\`research-desk
{"record":"claim-contribution","id":"${id}","claimId":"${claim.id}","kind":"challenge","payload":{"reason":"${reason}"}}
\`\`\``;

    await Promise.all([
      researchDeskWorker.onEvent(messageEvent(block('ctb_a', 'cohort mismatch'), 'msg_a'), context),
      researchDeskWorker.onEvent(messageEvent(block('ctb_b', 'date mismatch'), 'msg_b'), context)
    ]);

    const merged = await store.requireClaim(PROJECT, claim.id);
    expect(merged.contributions.map((entry) => entry.id).sort()).toEqual(['ctb_a', 'ctb_b']);
    expect(merged.version).toBe(2);
    expect(merged.status).toBe('contested');
  });

  test('a contribution completes its referenced assignment', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);
    await researchDeskWorker.onEvent(messageEvent(CLAIM_BLOCK, 'msg_claim'), context);
    const [claim] = await store.listClaims(PROJECT);
    if (!claim) throw new Error('expected an ingested claim');
    const assignment = await store.putAssignment(
      makeResearchAssignment({
        id: 'asg_verify',
        projectId: PROJECT,
        role: 'evidence-engineer',
        targetClaimId: claim.id,
        sessionId: 'ses_research',
        memberId: 'mesh-agent:evidence-engineer',
        objective: 'Challenge the claim',
        contextReceipt: { brief: 'Pricing research', sourceIds: [], claimIds: [claim.id], blockIds: [] },
        createdAt: NOW
      }),
      null
    );
    const contribution = `\`\`\`research-desk
{"record":"claim-contribution","id":"ctb_done","claimId":"${claim.id}","assignmentId":"${assignment.id}","kind":"negative-result","payload":{"attempt":"searched comparable launches","outcome":"no opposing primary source found"}}
\`\`\``;

    await researchDeskWorker.onEvent(messageEvent(contribution, 'msg_done', 'mesh-agent:evidence-engineer'), context);

    expect(await store.requireAssignment(PROJECT, assignment.id)).toEqual({
      ...assignment,
      state: 'completed',
      version: 1,
      updatedAt: NOW,
      completedAt: NOW
    });
  });

  test('a missing-block assignment links its new claim once and completes after preserving coverage semantics', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);
    await researchDeskWorker.onEvent(messageEvent(SOURCE_BLOCK), context);
    const report = await store.putReport(
      upsertBlock(
        makeReport({
          id: 'rep_1',
          projectId: PROJECT,
          title: 'Pricing research',
          question: 'Should the launch use consumption pricing?',
          sessionId: 'ses_report',
          createdAt: NOW
        }),
        0,
        {
          id: 'blk_missing',
          kind: 'factual',
          heading: 'Competitive landscape',
          markdown: 'Comparable vendors use consumption pricing.',
          evidenceIds: [],
          kindChangedByHuman: false
        },
        NOW
      ),
      null
    );
    const assignment = await store.putAssignment(
      makeResearchAssignment({
        id: 'asg_missing',
        projectId: PROJECT,
        role: 'researcher',
        targetBlockId: 'blk_missing',
        sessionId: 'ses_research',
        memberId: 'mesh-agent:researcher',
        objective: 'Find evidence for the missing competitive landscape block',
        contextReceipt: { brief: 'Pricing research', sourceIds: [], claimIds: [], blockIds: ['blk_missing'] },
        createdAt: NOW
      }),
      null
    );
    const assignedClaim = `\`\`\`research-desk
{"record":"claim","assignmentId":"${assignment.id}","text":"Comparable vendors retained seat pricing","citations":[{"sourceLocator":"https://a.test/pricing","excerpt":"pricing remains per seat","stance":"oppose"}]}
\`\`\``;

    await researchDeskWorker.onEvent(messageEvent(assignedClaim, 'msg_assigned'), context);
    await researchDeskWorker.onEvent(messageEvent(assignedClaim, 'msg_replayed'), context);

    const [claim] = await store.listClaims(PROJECT);
    if (!claim) throw new Error('expected the assigned claim');
    const linked = await store.requireReport(PROJECT);
    expect(linked.blocks[0]?.evidenceIds).toEqual([claim.id]);
    expect(reportCoverage(linked, new Map([[claim.id, claim]]))).toEqual([
      {
        blockId: 'blk_missing',
        heading: 'Competitive landscape',
        kind: 'factual',
        accepted: 0,
        contested: 1,
        missing: 1
      }
    ]);
    const accepted = await store.putClaim(
      decideClaim(claim, claim.version, { status: 'accepted', reason: 'human accepted the counterexample' }, LATER),
      claim.version
    );
    expect(reportCoverage(linked, new Map([[accepted.id, accepted]]))).toEqual([
      {
        blockId: 'blk_missing',
        heading: 'Competitive landscape',
        kind: 'factual',
        accepted: 1,
        contested: 0,
        missing: 0
      }
    ]);
    expect(await store.requireAssignment(PROJECT, assignment.id)).toEqual({
      ...assignment,
      state: 'completed',
      version: 1,
      updatedAt: NOW,
      completedAt: NOW
    });
    expect(linked.version).toBe(report.version + 1);
  });

  test('an assignment from another session does not capture the claim or complete', async () => {
    const { context } = fixture();
    const store = new ResearchDeskStore(context);
    const report = await store.putReport(
      upsertBlock(
        makeReport({
          id: 'rep_1',
          projectId: PROJECT,
          title: 'Pricing research',
          question: 'Should the launch use consumption pricing?',
          sessionId: 'ses_report',
          createdAt: NOW
        }),
        0,
        {
          id: 'blk_missing',
          kind: 'factual',
          heading: 'Competitive landscape',
          markdown: '',
          evidenceIds: [],
          kindChangedByHuman: false
        },
        NOW
      ),
      null
    );
    const assignment = await store.putAssignment(
      makeResearchAssignment({
        id: 'asg_other_session',
        projectId: PROJECT,
        role: 'researcher',
        targetBlockId: 'blk_missing',
        sessionId: 'ses_other',
        memberId: 'mesh-agent:researcher',
        objective: 'Find missing evidence',
        contextReceipt: { brief: 'Pricing research', sourceIds: [], claimIds: [], blockIds: ['blk_missing'] },
        createdAt: NOW
      }),
      null
    );
    const assignedClaim = `\`\`\`research-desk
{"record":"claim","assignmentId":"${assignment.id}","text":"A new claim from the wrong session"}
\`\`\``;

    await researchDeskWorker.onEvent(messageEvent(assignedClaim, 'msg_wrong_session'), context);

    expect((await store.listClaims(PROJECT)).map((claim) => claim.text)).toEqual([
      'A new claim from the wrong session'
    ]);
    expect(await store.requireReport(PROJECT)).toEqual(report);
    expect(await store.requireAssignment(PROJECT, assignment.id)).toEqual(assignment);
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
