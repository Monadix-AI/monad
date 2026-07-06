import type {
  RerankCall,
  RerankResult,
  SpeechCall,
  SpeechResult,
  TranscriptionCall,
  TranscriptionResult,
  VideoCall,
  VideoResult
} from '@monad/sdk-atom';

import { Buffer } from 'node:buffer';

import {
  fetchOpenRouterJson,
  finiteNumber,
  firstString,
  type OpenRouterProviderCall,
  type OpenRouterUsage,
  openRouterApiBase,
  openRouterHeaders,
  usageFromOpenRouter
} from './openrouter-http.ts';

export interface OpenRouterTranscriptionResponse {
  text?: unknown;
  segments?: Array<{ text?: unknown; start?: unknown; end?: unknown; start_second?: unknown; end_second?: unknown }>;
  language?: unknown;
  duration?: unknown;
  duration_in_seconds?: unknown;
  usage?: OpenRouterUsage;
}

export interface OpenRouterRerankResponse {
  results?: Array<{ index?: unknown; relevance_score?: unknown; score?: unknown }>;
  usage?: OpenRouterUsage;
}

export interface OpenRouterVideoResponse {
  id?: unknown;
  status?: unknown;
  video?: unknown;
  video_url?: unknown;
  url?: unknown;
  output?: unknown;
  error?: { message?: unknown };
}

function audioFormat(mediaType: string | undefined): string | undefined {
  if (!mediaType) return undefined;
  const [, subtype] = mediaType.split('/');
  return subtype?.split(';')[0];
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function audioPayload(audio: TranscriptionCall['audio'], mediaType: string | undefined): Record<string, unknown> {
  if (audio instanceof URL) return { url: audio.toString() };
  if (typeof audio === 'string') return { url: audio };
  return {
    data: bytesToBase64(audio),
    ...(audioFormat(mediaType) ? { format: audioFormat(mediaType) } : {})
  };
}

export async function openRouterSpeech(call: SpeechCall): Promise<SpeechResult> {
  const fetch = call.fetch ?? globalThis.fetch;
  const res = await fetch(`${openRouterApiBase(call)}/audio/speech`, {
    method: 'POST',
    headers: openRouterHeaders(call),
    body: JSON.stringify({
      model: call.modelId,
      input: call.text,
      ...(call.voice ? { voice: call.voice } : {})
    }),
    signal: call.signal
  });
  if (!res.ok) throw new Error(`OpenRouter /audio/speech failed: ${res.status} ${await res.text().catch(() => '')}`);
  return {
    audio: new Uint8Array(await res.arrayBuffer()),
    mediaType: res.headers.get('content-type') ?? 'audio/mpeg'
  };
}

export async function openRouterTranscribe(call: TranscriptionCall): Promise<TranscriptionResult> {
  const json = await fetchOpenRouterJson<OpenRouterTranscriptionResponse>(call, '/audio/transcriptions', {
    model: call.modelId,
    input_audio: audioPayload(call.audio, call.mediaType),
    ...(call.language ? { language: call.language } : {})
  });
  const text = typeof json.text === 'string' ? json.text : '';
  const segments = Array.isArray(json.segments)
    ? json.segments.flatMap((segment) => {
        const startSecond = finiteNumber(segment.start_second) ?? finiteNumber(segment.start);
        const endSecond = finiteNumber(segment.end_second) ?? finiteNumber(segment.end);
        return typeof segment.text === 'string' && startSecond !== undefined && endSecond !== undefined
          ? [{ text: segment.text, startSecond, endSecond }]
          : [];
      })
    : undefined;
  return {
    text,
    ...(segments?.length ? { segments } : {}),
    ...(typeof json.language === 'string' ? { language: json.language } : {}),
    ...((finiteNumber(json.duration_in_seconds) ?? finiteNumber(json.duration))
      ? { durationInSeconds: finiteNumber(json.duration_in_seconds) ?? finiteNumber(json.duration) }
      : {}),
    ...(usageFromOpenRouter(json.usage) ? { usage: usageFromOpenRouter(json.usage) } : {})
  };
}

export async function openRouterRerank(call: RerankCall): Promise<RerankResult> {
  const json = await fetchOpenRouterJson<OpenRouterRerankResponse>(call, '/rerank', {
    model: call.modelId,
    query: call.query,
    documents: call.documents,
    ...(call.topN ? { top_n: call.topN } : {})
  });
  const ranking = (json.results ?? []).flatMap((item) => {
    const index = finiteNumber(item.index);
    const score = finiteNumber(item.relevance_score) ?? finiteNumber(item.score);
    return index !== undefined && score !== undefined && call.documents[index] !== undefined
      ? [{ index, score, document: call.documents[index] }]
      : [];
  });
  return {
    ranking,
    ...(usageFromOpenRouter(json.usage) ? { usage: usageFromOpenRouter(json.usage) } : {})
  };
}

export async function openRouterVideo(call: VideoCall): Promise<VideoResult> {
  const create = await fetchOpenRouterJson<OpenRouterVideoResponse>(call, '/videos', {
    model: call.modelId,
    prompt: call.prompt,
    ...(call.image
      ? { image: call.image instanceof Uint8Array ? bytesToBase64(call.image) : call.image.toString() }
      : {}),
    ...(call.aspectRatio ? { aspect_ratio: call.aspectRatio } : {}),
    ...(call.resolution ? { resolution: call.resolution } : {}),
    ...(call.duration ? { duration: call.duration } : {}),
    ...(call.fps ? { fps: call.fps } : {}),
    ...(call.n ? { n: call.n } : {})
  });
  const directUrl = firstString(create.video_url, create.video, create.url, create.output);
  if (directUrl) return downloadVideo(call, directUrl);
  const id = typeof create.id === 'string' ? create.id : undefined;
  if (!id) throw new Error('OpenRouter /videos response did not include an id or video URL');
  if (create.status && create.status !== 'completed' && create.status !== 'succeeded') {
    const status = await pollOpenRouterVideo(call, id);
    const url = firstString(status.video_url, status.video, status.url, status.output);
    if (url) return downloadVideo(call, url);
  }
  return downloadVideo(call, `${openRouterApiBase(call)}/videos/${encodeURIComponent(id)}/content`);
}

async function pollOpenRouterVideo(call: OpenRouterProviderCall, id: string): Promise<OpenRouterVideoResponse> {
  const fetch = call.fetch ?? globalThis.fetch;
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(`${openRouterApiBase(call)}/videos/${encodeURIComponent(id)}`, {
      headers: openRouterHeaders(call, ''),
      signal: call.signal
    });
    if (!res.ok) throw new Error(`OpenRouter /videos/${id} failed: ${res.status} ${await res.text().catch(() => '')}`);
    const json = (await res.json()) as OpenRouterVideoResponse;
    if (json.error?.message) throw new Error(String(json.error.message));
    if (json.status === 'completed' || json.status === 'succeeded') return json;
    await Bun.sleep(1000);
  }
  throw new Error(`OpenRouter video "${id}" did not complete before timeout`);
}

async function downloadVideo(call: OpenRouterProviderCall, url: string): Promise<VideoResult> {
  const fetch = call.fetch ?? globalThis.fetch;
  const res = await fetch(url, { headers: openRouterHeaders(call, ''), signal: call.signal });
  if (!res.ok) throw new Error(`OpenRouter video download failed: ${res.status} ${await res.text().catch(() => '')}`);
  return {
    video: new Uint8Array(await res.arrayBuffer()),
    mediaType: res.headers.get('content-type') ?? 'video/mp4'
  };
}
