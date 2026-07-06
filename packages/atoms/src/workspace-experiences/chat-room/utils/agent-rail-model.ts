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
  nativeCliUsageLimitMeter,
  nativeCliUsageLimitMeterFromResponse
} from '../../experience/native-cli-observation/native-cli-observation.ts';

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
  const matchesAgent = (stream: NativeCliStreamView) => names.includes(stream.agentName);
  return (
    streams.find((stream) => matchesAgent(stream) && stream.status === 'running') ??
    streams.find((stream) => matchesAgent(stream))
  );
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
  // The daemon already normalizes with the same adapter it uses for parseOutput — see
  // observeFromStore/observeWithProviderHistory in apps/monad/src/services/native-cli/host.ts.
  // `events` is only absent on an `append`-only delta frame (no self-contained context to normalize);
  // that case degrades to an empty batch rather than re-deriving normalization on the client.
  return nativeAgentObservationProjectionSchema.parse({
    state: access.state,
    nativeCliSessionId: stream.id,
    ...(projectedDeliveryId ? { deliveryId: projectedDeliveryId } : {}),
    ...(access.turn ? { turn: access.turn } : {}),
    provider: access.provider,
    observedAt: access.observedAt,
    events: access.events ?? []
  });
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
