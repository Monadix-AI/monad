import type { TranscribeAudioRequest, TranscribeAudioResponse } from '@monad/protocol';

import { transcribeAudioResponseSchema } from '@monad/protocol';

import { clientOf, toError } from '../../../../endpoint-helpers.ts';
import { setRolesApi } from '../roles/set-roles.ts';

async function requestTranscription(
  args: TranscribeAudioRequest,
  api: { extra: unknown }
): Promise<{ data: TranscribeAudioResponse } | { error: ReturnType<typeof toError> }> {
  try {
    const res = await clientOf(api).fetch('/v1/settings/model/transcribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: toError({ status: res.status, value: body }) };
    return { data: transcribeAudioResponseSchema.parse(body) };
  } catch (err) {
    return { error: toError(err) };
  }
}

const transcribeAudioApi = setRolesApi.injectEndpoints({
  overrideExisting: true,
  endpoints: (builder) => ({
    transcribeAudio: builder.mutation<TranscribeAudioResponse, TranscribeAudioRequest>({
      queryFn: requestTranscription
    })
  })
});

export const { useTranscribeAudioMutation } = transcribeAudioApi;
