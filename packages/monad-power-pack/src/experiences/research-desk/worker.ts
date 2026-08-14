import type { ExperienceWorker, WorkplaceExperienceApiContext } from '@monad/sdk-atom';
import type { SourceRef } from './domain/index.ts';

import { isCitable, markSourceRot } from './domain/index.ts';
import { claimFromPayload, parsePayloads, sourceFromPayload } from './ingest.ts';
import { ResearchDeskStore } from './store.ts';

const RECHECK_KEY = 'source-recheck';
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function scheduleRecheck(context: WorkplaceExperienceApiContext, projectId: string, from: number): Promise<void> {
  return context.workerScheduler.schedule(projectId, {
    key: RECHECK_KEY,
    runAt: new Date(from + RECHECK_INTERVAL_MS).toISOString()
  });
}

async function ingestMessage(
  context: WorkplaceExperienceApiContext,
  input: { projectId: string; sessionId: string; messageId: string; memberId: string; text: string; now: string }
): Promise<void> {
  const payloads = parsePayloads(input.text);
  if (payloads.length === 0) return;
  const store = new ResearchDeskStore(context);
  const byLocator = new Map((await store.listSources(input.projectId)).map((source) => [source.locator, source.id]));

  for (const payload of payloads) {
    if (payload.record === 'source') {
      const source = sourceFromPayload(payload, input);
      const existing = await store.getSource(input.projectId, source.id);
      if (existing) continue;
      await store.putSource(source, null);
      byLocator.set(source.locator, source.id);
      continue;
    }
    const claim = claimFromPayload(payload, input, (locator) => byLocator.get(locator) ?? null);
    const existing = await store.getClaim(input.projectId, claim.id);
    // A claim the agent repeats is the same claim; re-ingesting it would silently discard the human
    // ruling already recorded against it.
    if (existing) continue;
    await store.putClaim(claim, null);
  }
}

/** Rechecks a captured source and reports only whether it still resolves. It never re-captures: the
 *  snapshot a published claim cites has to stay exactly as it was read. */
async function recheck(context: WorkplaceExperienceApiContext, source: SourceRef, now: string): Promise<void> {
  if (source.kind !== 'url' || !isCitable(source)) return;
  const store = new ResearchDeskStore(context);
  try {
    const response = await fetch(source.locator, { method: 'HEAD', redirect: 'follow' });
    if (response.ok) return;
    await store.putSource(
      markSourceRot(source, source.version, 'unreachable', `the source answered ${response.status}`, now),
      source.version
    );
  } catch (error) {
    await store.putSource(
      markSourceRot(source, source.version, 'unreachable', errorReason(error), now),
      source.version
    );
  }
}

function errorReason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'the source could not be reached';
}

export const researchDeskWorker: ExperienceWorker = {
  experienceId: 'research-desk',
  subscriptions: ['session.message.completed'],

  async onProjectStart(projectId, context) {
    await scheduleRecheck(context, projectId, Date.parse(new Date().toISOString()));
  },

  async onEvent(event, context) {
    if (event.type !== 'session.message.completed') return;
    const payload = event.payload as { message?: { id?: string; role?: string; text?: string; memberId?: string } };
    const message = payload.message;
    if (!message?.id || !message.text || message.role !== 'assistant') return;
    await ingestMessage(context, {
      projectId: event.projectId,
      sessionId: event.sessionId,
      messageId: message.id,
      memberId: message.memberId ?? 'agent',
      text: message.text,
      now: event.createdAt
    });
  },

  async onWake(input, context) {
    if (input.key !== RECHECK_KEY) return;
    const store = new ResearchDeskStore(context);
    for (const source of await store.listSources(input.projectId)) {
      await recheck(context, source, input.now);
    }
    await scheduleRecheck(context, input.projectId, Date.parse(input.now));
  }
};
