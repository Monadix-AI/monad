'use client';

import type {
  GetRolesResponse,
  ListProfilesResponse,
  TranscribeAudioRequest,
  TranscribeAudioResponse
} from '@monad/protocol';

import { getRolesResponseSchema, listProfilesResponseSchema, transcribeAudioResponseSchema } from '@monad/protocol';

export type ChatRoomComposerClient = {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  openModelSettings?: () => void;
};

let composerClient: ChatRoomComposerClient | undefined;

export function configureChatRoomComposerClient(client: ChatRoomComposerClient): void {
  composerClient = client;
}

function requireComposerClient(): ChatRoomComposerClient {
  if (!composerClient) throw new Error('chatroom composer client is not configured');
  return composerClient;
}

async function fetchJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await requireComposerClient().fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`chatroom composer request failed: ${res.status}`);
  return body;
}

export async function readChatRoomModelRoles(): Promise<GetRolesResponse> {
  return getRolesResponseSchema.parse(await fetchJson('/v1/settings/model/roles'));
}

export async function readChatRoomProfiles(): Promise<ListProfilesResponse> {
  return listProfilesResponseSchema.parse(await fetchJson('/v1/settings/model/profiles'));
}

export async function transcribeChatRoomAudio(args: TranscribeAudioRequest): Promise<TranscribeAudioResponse> {
  return transcribeAudioResponseSchema.parse(
    await fetchJson('/v1/settings/model/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args)
    })
  );
}

export function openChatRoomModelSettings(): void {
  composerClient?.openModelSettings?.();
}
