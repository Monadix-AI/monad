'use client';

import type {
  NativeAgentDeliveryId,
  NativeCliObservationAccessResponse,
  NativeCliUsageResponse,
  TranscriptTargetId
} from '@monad/protocol';

import { nativeCliObservationAccessResponseSchema, nativeCliUsageResponseSchema } from '@monad/protocol';

type ClientFetch = (path: string, init?: RequestInit) => Promise<Response>;

async function fetchJson(fetch: ClientFetch, path: string): Promise<unknown> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`chatroom native CLI request failed: ${res.status}`);
  return res.json();
}

export async function readNativeCliObservation(
  fetch: ClientFetch,
  args: { id: string; transcriptTargetId: TranscriptTargetId }
): Promise<NativeCliObservationAccessResponse> {
  const query = new URLSearchParams({ transcriptTargetId: args.transcriptTargetId });
  return nativeCliObservationAccessResponseSchema.parse(
    await fetchJson(fetch, `/v1/native-cli-sessions/${encodeURIComponent(args.id)}/observation?${query}`)
  );
}

export async function readNativeAgentDeliveryObservation(
  fetch: ClientFetch,
  args: { id: NativeAgentDeliveryId; transcriptTargetId: TranscriptTargetId }
): Promise<NativeCliObservationAccessResponse> {
  const query = new URLSearchParams({ transcriptTargetId: args.transcriptTargetId });
  return nativeCliObservationAccessResponseSchema.parse(
    await fetchJson(fetch, `/v1/native-agent-deliveries/${encodeURIComponent(args.id)}/observation?${query}`)
  );
}

export async function readNativeCliUsage(fetch: ClientFetch, agentName: string): Promise<NativeCliUsageResponse> {
  return nativeCliUsageResponseSchema.parse(
    await fetchJson(fetch, `/v1/native-cli-agents/${encodeURIComponent(agentName)}/usage`)
  );
}
