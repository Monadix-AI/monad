'use client';

import type {
  NativeAgentDeliveryId,
  NativeCliObservationAccessResponse,
  NativeCliUsageResponse,
  TranscriptTargetId
} from '@monad/protocol';

import { nativeCliObservationAccessResponseSchema, nativeCliUsageResponseSchema } from '@monad/protocol';

export type ChatRoomNativeCliClient = {
  fetch(path: string): Promise<Response>;
};

let nativeCliClient: ChatRoomNativeCliClient | undefined;

export function configureChatRoomNativeCliClient(client: ChatRoomNativeCliClient): void {
  nativeCliClient = client;
}

function requireNativeCliClient(): ChatRoomNativeCliClient {
  if (!nativeCliClient) throw new Error('chatroom native CLI client is not configured');
  return nativeCliClient;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await requireNativeCliClient().fetch(path);
  if (!res.ok) throw new Error(`chatroom native CLI request failed: ${res.status}`);
  return res.json();
}

export async function readNativeCliObservation(args: {
  id: string;
  transcriptTargetId: TranscriptTargetId;
}): Promise<NativeCliObservationAccessResponse> {
  const query = new URLSearchParams({ transcriptTargetId: args.transcriptTargetId });
  return nativeCliObservationAccessResponseSchema.parse(
    await fetchJson(`/v1/native-cli-sessions/${encodeURIComponent(args.id)}/observation?${query}`)
  );
}

export async function readNativeAgentDeliveryObservation(args: {
  id: NativeAgentDeliveryId;
  transcriptTargetId: TranscriptTargetId;
}): Promise<NativeCliObservationAccessResponse> {
  const query = new URLSearchParams({ transcriptTargetId: args.transcriptTargetId });
  return nativeCliObservationAccessResponseSchema.parse(
    await fetchJson(`/v1/native-agent-deliveries/${encodeURIComponent(args.id)}/observation?${query}`)
  );
}

export async function readNativeCliUsage(agentName: string): Promise<NativeCliUsageResponse> {
  return nativeCliUsageResponseSchema.parse(
    await fetchJson(`/v1/native-cli-agents/${encodeURIComponent(agentName)}/usage`)
  );
}
