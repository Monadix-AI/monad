import type {
  NativeAgentDeliveryId,
  NativeAgentObservationProjection,
  NativeCliObservationAccessResponse,
  NativeCliUsageResponse
} from '@monad/protocol';
import type { NativeCliUsageLimitMeter } from '../../experience/native-cli-observation/native-cli-observation.ts';
import type { NativeCliStreamView, Participant } from '../../experience/types.ts';

import { nativeAgentObservationProjectionSchema } from '@monad/protocol';

import {
  nativeCliStreamItems,
  nativeCliUsageLimitMeter,
  nativeCliUsageLimitMeterFromResponse
} from '../../experience/native-cli-observation/native-cli-observation.ts';

function newestStream(streams: NativeCliStreamView[]): NativeCliStreamView | undefined {
  return [...streams].sort((a, b) => {
    const byObservedAt = (b.observedAt ?? '').localeCompare(a.observedAt ?? '');
    return byObservedAt === 0 ? b.id.localeCompare(a.id) : byObservedAt;
  })[0];
}

export function agentObservationStream(
  observation:
    | {
        agentId?: string;
        agentName?: string;
        deliveryId?: NativeAgentDeliveryId;
        nativeCliSessionId?: string;
      }
    | null
    | undefined,
  streams: readonly NativeCliStreamView[]
): NativeCliStreamView | undefined {
  if (!observation) return undefined;
  if (observation.nativeCliSessionId) {
    return streams.find((stream) => stream.id === observation.nativeCliSessionId);
  }
  const names = [observation.agentId, observation.agentName].filter((value): value is string => Boolean(value));
  if (names.length === 0) return undefined;
  const matchesAgent = (stream: NativeCliStreamView) => {
    const streamNames = [stream.agentName, stream.templateAgentName, ...(stream.agentAliases ?? [])].filter(
      (value): value is string => Boolean(value)
    );
    return names.some((name) => streamNames.includes(name));
  };
  const matches = streams.filter(matchesAgent);
  return newestStream(matches.filter((stream) => stream.status === 'running')) ?? newestStream(matches);
}

export function observedRailAgent(
  observation:
    | {
        agentId?: string;
        agentName?: string;
        deliveryId?: NativeAgentDeliveryId;
        nativeCliSessionId?: string;
      }
    | null
    | undefined,
  observedStream: NativeCliStreamView | undefined,
  agents: readonly Participant[]
): Participant | undefined {
  if (!observation) return undefined;
  const streamAgentName = observedStream?.agentName;
  return (
    agents.find((agent) => agent.id === observation.agentId) ??
    agents.find((agent) => agent.id === streamAgentName) ??
    agents.find((agent) => agent.name === observation.agentName) ??
    agents.find((agent) => agent.name === streamAgentName)
  );
}

export function isActiveRailAgent(agent: Participant): boolean {
  return agent.presence === 'working';
}

export function railAgentActivityPhase(agent: Participant): Participant['activityPhase'] {
  return agent.activityPhase;
}

export function shouldAnimateRailAgent(agent: Participant): boolean {
  return railAgentActivityPhase(agent) !== undefined;
}

export function groupProjectRailAgents(agents: readonly Participant[]): {
  active: Participant[];
  standBy: Participant[];
} {
  const active: Participant[] = [];
  const standBy: Participant[] = [];
  for (const agent of agents) {
    if (isActiveRailAgent(agent)) active.push(agent);
    else standBy.push(agent);
  }
  return { active, standBy };
}

export function sortedProjectRailAgents(agents: readonly Participant[]): Participant[] {
  return [...agents].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return byName === 0 ? a.id.localeCompare(b.id) : byName;
  });
}

export function observationProjectionFromAccess(
  stream: NativeCliStreamView | undefined,
  access: NativeCliObservationAccessResponse | undefined,
  deliveryId?: NativeAgentDeliveryId
): NativeAgentObservationProjection | undefined {
  if (!stream || !access) return undefined;
  const projectedDeliveryId = access.deliveryId ?? deliveryId;
  if (access.state === 'unavailable') {
    return nativeAgentObservationProjectionSchema.parse({
      state: 'unavailable',
      nativeCliSessionId: stream.id,
      ...(projectedDeliveryId ? { deliveryId: projectedDeliveryId } : {}),
      ...(access.turn ? { turn: access.turn } : {}),
      provider: access.provider,
      reason: access.reason
    });
  }
  // The daemon includes normalized `events` on full snapshots (the poll path, and the SSE's first
  // frame). The SSE hub's steady-state pushes carry only the folded `output` and no `events`, so
  // re-derive them from `output` with the same client parser — otherwise every delta frame would
  // blank the panel until the next full snapshot.
  const events =
    access.events && access.events.length > 0
      ? access.events
      : access.output
        ? nativeCliStreamItems({ id: stream.id, provider: access.provider ?? stream.provider, output: access.output })
        : [];
  return nativeAgentObservationProjectionSchema.parse({
    state: access.state,
    nativeCliSessionId: stream.id,
    ...(projectedDeliveryId ? { deliveryId: projectedDeliveryId } : {}),
    ...(access.turn ? { turn: access.turn } : {}),
    provider: access.provider,
    observedAt: access.observedAt,
    events
  });
}

export function shouldProjectObservationAccess(args: {
  access?: NativeCliObservationAccessResponse;
  deliveryId?: NativeAgentDeliveryId;
  historyRequested: boolean;
}): boolean {
  return (
    Boolean(args.deliveryId) ||
    args.access?.state !== 'history' ||
    args.historyRequested ||
    Boolean(args.access?.state === 'history' && args.access.events?.length)
  );
}

export function streamWithObservationProjection(
  stream: NativeCliStreamView | undefined,
  projection: NativeAgentObservationProjection | undefined
): NativeCliStreamView | undefined {
  if (!stream || !projection) return stream;
  if (projection.state === 'unavailable') return { ...stream, output: '', items: [] };
  return {
    ...stream,
    output: projection.events.map((event) => event.text).join('\n\n'),
    items: projection.events
  };
}

export function usageMeterFromObservationAccess(args: {
  access?: NativeCliObservationAccessResponse;
  provider?: NativeCliStreamView['provider'];
  stream?: NativeCliStreamView;
  usage?: NativeCliUsageResponse;
}): NativeCliUsageLimitMeter | null {
  const fromUsageEndpoint = nativeCliUsageLimitMeterFromResponse(args.usage);
  if (fromUsageEndpoint) return fromUsageEndpoint;
  // The daemon already normalizes the usage/rate-limit meter with the same adapter it uses for
  // parseOutput (see observeFromStore/observeWithProviderHistory) — no client-side re-derivation
  // when an access response is present. `stream`-only callers (no polled access response yet, e.g.
  // a session-list-built NativeCliStreamView) still parse client-side as a fallback.
  if (args.access && args.access.state !== 'unavailable') return args.access.usageMeter ?? null;
  return nativeCliUsageLimitMeter({ output: args.stream?.output, provider: args.provider ?? args.stream?.provider });
}
