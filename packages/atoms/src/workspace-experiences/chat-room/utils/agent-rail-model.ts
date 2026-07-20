import type { AgentObservationEvent, MeshAgentUsageResponse, NativeAgentDeliveryId } from '@monad/protocol';
import type { MeshAgentUsageLimitMeter } from '../../experience/mesh-agent-observation/mesh-agent-observation.ts';
import type { MeshAgentStreamView, Participant } from '../../experience/types.ts';

import {
  meshAgentUsageLimitMeter,
  meshAgentUsageLimitMeterFromResponse
} from '../../experience/mesh-agent-observation/mesh-agent-observation.ts';
import { meshAgentObservationActivity } from '../../experience/mesh-agent-presence.ts';

function newestStream(streams: MeshAgentStreamView[]): MeshAgentStreamView | undefined {
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
        meshSessionId?: string;
      }
    | null
    | undefined,
  streams: readonly MeshAgentStreamView[]
): MeshAgentStreamView | undefined {
  if (!observation) return undefined;
  if (observation.meshSessionId) {
    return streams.find((stream) => stream.id === observation.meshSessionId);
  }
  const names = [observation.agentId, observation.agentName].filter((value): value is string => Boolean(value));
  if (names.length === 0) return undefined;
  const matchesAgent = (stream: MeshAgentStreamView) => {
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
        meshSessionId?: string;
      }
    | null
    | undefined,
  observedStream: MeshAgentStreamView | undefined,
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

export function isActiveRailAgent(agent: Participant, observationEvents?: readonly AgentObservationEvent[]): boolean {
  return observationEvents ? meshAgentObservationActivity(observationEvents).active : agent.presence === 'working';
}

export function railAgentActivityPhase(
  agent: Participant,
  observationEvents?: readonly AgentObservationEvent[]
): Participant['activityPhase'] {
  if (observationEvents) return meshAgentObservationActivity(observationEvents).phase;
  if (agent.presence !== 'working') return undefined;
  return agent.activityPhase ?? 'thinking';
}

export function shouldAnimateRailAgent(
  agent: Participant,
  observationEvents?: readonly AgentObservationEvent[]
): boolean {
  return isActiveRailAgent(agent, observationEvents);
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

export function meshAgentUsageMeter(args: {
  provider?: MeshAgentStreamView['provider'];
  stream?: MeshAgentStreamView;
  usage?: MeshAgentUsageResponse;
}): MeshAgentUsageLimitMeter | null {
  const fromUsageEndpoint = meshAgentUsageLimitMeterFromResponse(args.usage);
  if (fromUsageEndpoint) return fromUsageEndpoint;
  return meshAgentUsageLimitMeter({
    output: args.stream?.output,
    provider: args.provider ?? args.stream?.provider
  });
}
