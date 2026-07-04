'use client';

import type { TranscribeAudioRequest, TranscribeAudioResponse } from '@monad/protocol';

import { transcribeAudioResponseSchema } from '@monad/protocol';

type ClientFetch = (path: string, init?: RequestInit) => Promise<Response>;

async function fetchJson(fetch: ClientFetch, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`chatroom composer request failed: ${res.status}`);
  return body;
}

export async function transcribeChatRoomAudio(
  fetch: ClientFetch,
  args: TranscribeAudioRequest
): Promise<TranscribeAudioResponse> {
  return transcribeAudioResponseSchema.parse(
    await fetchJson(fetch, '/v1/settings/model/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args)
    })
  );
}
