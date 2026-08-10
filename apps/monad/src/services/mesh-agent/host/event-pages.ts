import type {
  AgentObservationEvent,
  MeshConvenienceEventPage,
  MeshEventPageRequest,
  MeshRawEventPage,
  ObservationPosition
} from '@monad/protocol';
import type {
  MeshAgentEventPageRequest,
  MeshAgentProjectionPage,
  MeshAgentProviderEventContext
} from '@monad/sdk-atom';
import type { LiveMeshSession } from '#/services/mesh-agent/host/host-types.ts';
import type { Store } from '#/store/db/index.ts';

import { createLogger } from '@monad/logger';
import {
  formatObservationCursor,
  MESH_NATIVE_SESSION_UNAVAILABLE_REASON,
  observationCursorSchema,
  parseObservationPageBefore
} from '@monad/protocol';
import { toFallbackAgentObservationEvent } from '@monad/sdk-atom';

import { MeshAgentError } from '#/services/mesh-agent/errors.ts';
import {
  type EventCursor,
  encodeEventCursor,
  eventCursorFromPosition
} from '#/services/mesh-agent/host/event-cursor.ts';
import { conveniencePatchFrame } from '#/services/mesh-agent/host/observation-dual.ts';
import { getMeshAgentProviderAdapter } from '#/services/mesh-agent/index.ts';
import { managedProjectRuntimeWorkspaces } from '#/services/mesh-agent/managed-project.ts';

// An adapter projector numbers its events by their position in the output IT was handed, so a page
// projected from an older live-store window restarts that numbering at 0 and its event ids collide
// with the live window's. A consumer merges by event id, so the collision silently overwrites the
// rendered rows instead of prepending — the page namespace keeps the two disjoint.
function livePageProjectionId(id: string, observationEpoch: string, beforeSeq: number): string {
  return `${id}@${observationEpoch}:${beforeSeq}`;
}

function providerEventPageRequest(req: MeshAgentEventPageRequest, cursor: EventCursor): MeshAgentEventPageRequest {
  const { before: _ignored, ...rest } = req;
  return { ...rest, ...(cursor.kind === 'provider' && cursor.token ? { before: cursor.token } : {}) };
}

interface MeshAgentEventPagesContext {
  live: Map<string, LiveMeshSession>;
  monadHome?: string;
  resolveAgentEnv?: (agentName: string) => Promise<Record<string, string> | undefined>;
  store: Store;
}

type ProviderEventsUnavailableReason = 'unsupported' | 'not-found' | 'temporary';

class ProviderEventsUnavailableError extends Error {
  constructor(
    readonly reason: ProviderEventsUnavailableReason,
    readonly providerCause?: unknown
  ) {
    super(`provider events unavailable: ${reason}`);
    this.name = 'ProviderEventsUnavailableError';
  }
}

function unavailableConveniencePage(reason: string): MeshConvenienceEventPage {
  return { frames: [{ kind: 'unavailable', reason }] };
}

const log = createLogger('mesh-agent');

export class MeshAgentEventPages {
  constructor(private readonly context: MeshAgentEventPagesContext) {}

  private async providerContext(args: {
    meshSessionId: string;
    agentName: string;
    providerSessionRef: string;
    workingPath: string;
  }): Promise<MeshAgentProviderEventContext> {
    const env = await this.context.resolveAgentEnv?.(args.agentName);
    const row = this.context.store.getMeshSession(args.meshSessionId);
    const session = row ? this.context.store.getSession(row.transcriptTargetId) : null;
    const managedRuntimeWorkspace =
      this.context.monadHome &&
      row?.runtimeRole === 'managed-project-agent' &&
      row.projectMemberId &&
      session?.projectId
        ? managedProjectRuntimeWorkspaces({
            monadHome: this.context.monadHome,
            projectId: session.projectId,
            sessionId: row.transcriptTargetId,
            agentId: row.projectMemberId
          }).runtime
        : undefined;
    return {
      providerSessionRef: args.providerSessionRef,
      workingPath: args.workingPath,
      ...(env ? { env } : {}),
      ...(managedRuntimeWorkspace ? { managedRuntimeWorkspace } : {})
    };
  }

  async rawEventsPage(id: string, req: Omit<MeshEventPageRequest, 'view'>): Promise<MeshRawEventPage> {
    const beforePosition = parseObservationPageBefore(req.before);
    const cursor = eventCursorFromPosition(beforePosition);
    const live = this.context.live.get(id);
    if (live) {
      const providerSessionRef = live.providerSessionRef ?? undefined;
      const liveRawStore = live.liveRawStore;
      if (beforePosition?.kind === 'live' && beforePosition.observationEpoch === liveRawStore?.epoch && liveRawStore) {
        const page = liveRawStore.page({
          before: beforePosition.seq,
          limit: req.limit,
          sortDirection: 'desc'
        });
        return {
          records: page.rows.map((row) => ({
            cursor: liveRawStore.cursorBefore(row.seq),
            data: row.payload,
            observedAt: row.observedAt
          })),
          coverage: 'exact',
          ...(page.nextBefore !== undefined
            ? { nextCursor: liveRawStore.cursorBefore(page.nextBefore) }
            : providerSessionRef
              ? { nextCursor: encodeEventCursor('') }
              : {})
        };
      }
      const workingPath = live.workingPath;
      if (live.adapter.events.readPage && providerSessionRef && workingPath) {
        const result = await live.adapter.events.readPage(
          await this.providerContext({
            meshSessionId: id,
            agentName: live.agentName,
            providerSessionRef,
            workingPath
          }),
          {
            ...(cursor.kind === 'provider' && cursor.token ? { before: cursor.token } : {}),
            view: 'raw',
            limit: req.limit
          }
        );
        if (result.state === 'available' && result.view === 'raw') {
          return {
            records: result.records,
            coverage: result.coverage,
            ...(result.nextCursor ? { nextCursor: encodeEventCursor(result.nextCursor) } : {})
          };
        }
      }
      return { records: [], coverage: 'settled' };
    }
    const row = this.context.store.getMeshSession(id);
    if (row?.providerSessionRef) {
      const adapter = getMeshAgentProviderAdapter(row.provider);
      const pageRequest = {
        view: 'raw' as const,
        ...(cursor.kind === 'provider' && cursor.token ? { before: cursor.token } : {}),
        limit: req.limit
      };
      const local = await adapter.events
        .readPage?.(
          await this.providerContext({
            meshSessionId: id,
            agentName: row.agentName,
            providerSessionRef: row.providerSessionRef,
            workingPath: row.workingPath
          }),
          pageRequest
        )
        .catch(() => undefined);
      if (local?.state === 'available' && local.view === 'raw') {
        return {
          records: local.records,
          coverage: local.coverage,
          ...(local.nextCursor ? { nextCursor: encodeEventCursor(local.nextCursor) } : {})
        };
      }
    }
    return { records: [], coverage: 'settled' };
  }

  /** Earlier provider events projected into the neutral convenience plane and mapped to `upsert`
   *  frames a consumer merges into its timeline. */
  async convenienceEventsPage(id: string, req: Omit<MeshEventPageRequest, 'view'>): Promise<MeshConvenienceEventPage> {
    const provider = this.context.live.get(id)?.provider ?? this.context.store.getMeshSession(id)?.provider;
    if (!provider) return { frames: [] };
    const beforePosition = parseObservationPageBefore(req.before);
    let page: MeshAgentProjectionPage;
    try {
      page = await this.projectedEventsPage(id, { ...req, view: 'convenience' }, beforePosition);
    } catch (error) {
      if (error instanceof ProviderEventsUnavailableError) {
        if (error.providerCause !== undefined) {
          log.error(
            { meshSessionId: id, provider, err: error.providerCause, event: 'mesh.convenienceEventsPage' },
            'convenience event page failed'
          );
        }
        return unavailableConveniencePage(
          error.reason === 'not-found' ? MESH_NATIVE_SESSION_UNAVAILABLE_REASON : 'provider events unavailable'
        );
      }
      if (error instanceof MeshAgentError && error.code === 'unsupported_capability') return { frames: [] };
      // The frame is deliberately generic, so without this line an internal failure is
      // indistinguishable from an offline provider and leaves no trace to report.
      log.error(
        { meshSessionId: id, provider, err: error, event: 'mesh.convenienceEventsPage' },
        'convenience event page failed'
      );
      return unavailableConveniencePage('provider events unavailable');
    }
    const adapter = getMeshAgentProviderAdapter(provider);
    const runtime = adapter.observationRuntime;
    const events = page.events
      .map((event) =>
        runtime ? runtime.toAgentObservationEvent(event) : toFallbackAgentObservationEvent(event, adapter.observation)
      )
      .filter((event): event is AgentObservationEvent => event !== null);
    // An event page is request/response, so its patch carries the provider position the page was
    // taken at (an absent `before` being the latest page) rather than a live row sequence.
    const requestedCursor = eventCursorFromPosition(beforePosition);
    const patch = conveniencePatchFrame(
      requestedCursor.kind === 'none'
        ? formatObservationCursor({ kind: 'provider', token: '' })
        : formatObservationCursor(requestedCursor),
      events.map((event) => ({ op: 'upsert' as const, event }))
    );
    return {
      frames: patch ? [patch] : [],
      ...(page.nextCursor ? { nextCursor: observationCursorSchema.parse(page.nextCursor) } : {})
    };
  }

  async projectedEventsPage(
    id: string,
    req: MeshAgentEventPageRequest,
    beforePosition = parseObservationPageBefore(req.before)
  ): Promise<MeshAgentProjectionPage> {
    const live = this.context.live.get(id);
    if (!live) return this.storedProjectedEventsPage(id, req, beforePosition);
    const liveRawStore = live.liveRawStore;
    if (beforePosition?.kind === 'live' && beforePosition.observationEpoch === liveRawStore?.epoch && liveRawStore) {
      const page = liveRawStore.page({
        before: beforePosition.seq,
        limit: req.limit,
        sortDirection: 'desc'
      });
      const projector = live.adapter.events.createLiveProjector?.({
        id: livePageProjectionId(id, beforePosition.observationEpoch, beforePosition.seq),
        ...(live.providerSessionRef ? { providerSessionRef: live.providerSessionRef } : {})
      });
      let projection: MeshAgentProjectionPage = { events: [] };
      if (projector) {
        for (const row of page.rows) projection = projector.advance(row.payload, row.observedAt);
      } else {
        const output = page.rows.map((row) => row.payload).join('');
        projection = live.adapter.events.projectLive({
          id: livePageProjectionId(id, beforePosition.observationEpoch, beforePosition.seq),
          output,
          mode: 'events',
          ...(page.rows.at(-1)?.observedAt ? { observedAt: page.rows.at(-1)?.observedAt } : {})
        });
      }
      return {
        events: projection.events,
        ...(page.nextBefore !== undefined
          ? { nextCursor: liveRawStore.cursorBefore(page.nextBefore) }
          : live.providerSessionRef
            ? { nextCursor: encodeEventCursor('') }
            : {})
      };
    }
    const cursor = eventCursorFromPosition(beforePosition);
    const providerSessionRef = live.providerSessionRef ?? undefined;
    const workingPath = live.workingPath;
    const providerReq = providerEventPageRequest(req, cursor);
    if (live.adapter.events.readPage && providerSessionRef && workingPath) {
      const result = await live.adapter.events
        .readPage(
          await this.providerContext({
            meshSessionId: id,
            agentName: live.agentName,
            providerSessionRef,
            workingPath
          }),
          { view: 'convenience', before: providerReq.before, limit: providerReq.limit }
        )
        .catch((error) => {
          throw new ProviderEventsUnavailableError('temporary', error);
        });
      if (result.state === 'available' && result.view === 'convenience') {
        return {
          events: result.events,
          ...(result.nextCursor ? { nextCursor: encodeEventCursor(result.nextCursor) } : {})
        };
      }
      if (result.state === 'unavailable') throw new ProviderEventsUnavailableError(result.reason);
    }
    throw new MeshAgentError('unsupported_capability', `provider events unavailable for live session: ${id}`);
  }

  private async storedProjectedEventsPage(
    id: string,
    req: MeshAgentEventPageRequest,
    beforePosition: ObservationPosition | undefined
  ): Promise<MeshAgentProjectionPage> {
    const row = this.context.store.getMeshSession(id);
    const cursor = eventCursorFromPosition(beforePosition);
    if (row?.providerSessionRef) {
      const adapter = getMeshAgentProviderAdapter(row.provider);
      const pageRequest = {
        view: 'convenience' as const,
        before: cursor.kind === 'provider' && cursor.token ? cursor.token : undefined,
        limit: req.limit
      };
      const local = await adapter.events
        .readPage?.(
          await this.providerContext({
            meshSessionId: id,
            agentName: row.agentName,
            providerSessionRef: row.providerSessionRef,
            workingPath: row.workingPath
          }),
          pageRequest
        )
        .catch((error) => {
          throw new ProviderEventsUnavailableError('temporary', error);
        });
      if (local?.state === 'available' && local.view === 'convenience') {
        return {
          events: local.events,
          ...(local.nextCursor ? { nextCursor: encodeEventCursor(local.nextCursor) } : {})
        };
      }
      if (local?.state === 'unavailable') throw new ProviderEventsUnavailableError(local.reason);
    }
    throw new MeshAgentError('unsupported_capability', `provider events unavailable for stopped session: ${id}`);
  }
}
