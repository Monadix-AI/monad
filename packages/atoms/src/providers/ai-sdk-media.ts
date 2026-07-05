import type {
  EmbedCall,
  EmbedResult,
  ImageCall,
  ImageResult,
  RerankCall,
  RerankResult,
  SpeechCall,
  SpeechResult,
  TranscriptionCall,
  TranscriptionResult,
  VideoCall,
  VideoResult
} from '@monad/sdk-atom';
import type { EmbeddingModel, ImageModel, RerankingModel, SpeechModel, TranscriptionModel } from 'ai';

import {
  embedMany,
  generateImage,
  experimental_generateSpeech as generateSpeech,
  experimental_generateVideo as generateVideo,
  rerank,
  experimental_transcribe as transcribe
} from 'ai';

export type VideoModel = Parameters<typeof generateVideo>[0]['model'];

export async function imageViaAiSdk(call: ImageCall, model: ImageModel): Promise<ImageResult> {
  const { image } = await generateImage({
    model,
    prompt: call.prompt,
    ...(call.size ? { size: call.size as `${number}x${number}` } : {}),
    ...(call.n ? { n: call.n } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return { image: image.uint8Array, mediaType: image.mediaType ?? 'image/png' };
}

export async function videoViaAiSdk(call: VideoCall, model: VideoModel): Promise<VideoResult> {
  const image = call.image instanceof URL ? call.image.toString() : call.image;
  const prompt = image === undefined ? call.prompt : { image, ...(call.prompt ? { text: call.prompt } : {}) };
  const { video } = await generateVideo({
    model,
    prompt,
    ...(call.n ? { n: call.n } : {}),
    ...(call.aspectRatio ? { aspectRatio: call.aspectRatio as `${number}:${number}` } : {}),
    ...(call.resolution ? { resolution: call.resolution as `${number}x${number}` } : {}),
    ...(call.duration ? { duration: call.duration } : {}),
    ...(call.fps ? { fps: call.fps } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return { video: video.uint8Array, mediaType: video.mediaType ?? 'video/mp4' };
}

export async function embedViaAiSdk(call: EmbedCall, model: EmbeddingModel): Promise<EmbedResult> {
  const { embeddings, usage } = await embedMany({
    model,
    values: call.texts,
    // monad does its own gateway-level credential fallback; disable the SDK's per-call retry.
    maxRetries: 0,
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  // embedMany reports a single `tokens` count; embeddings consume input tokens only.
  return { embeddings, usage: typeof usage?.tokens === 'number' ? { inputTokens: usage.tokens } : undefined };
}

export async function speechViaAiSdk(call: SpeechCall, model: SpeechModel): Promise<SpeechResult> {
  const { audio } = await generateSpeech({
    model,
    text: call.text,
    ...(call.voice ? { voice: call.voice } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return { audio: audio.uint8Array, mediaType: audio.mediaType ?? 'audio/mpeg' };
}

export async function transcribeViaAiSdk(
  call: TranscriptionCall,
  model: TranscriptionModel
): Promise<TranscriptionResult> {
  const { text, segments, language, durationInSeconds } = await transcribe({
    model,
    audio: call.audio,
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return {
    text,
    ...(segments.length ? { segments } : {}),
    ...(language ? { language } : {}),
    ...(durationInSeconds !== undefined ? { durationInSeconds } : {})
  };
}

export async function rerankViaAiSdk(call: RerankCall, model: RerankingModel): Promise<RerankResult> {
  const result = await rerank({
    model,
    query: call.query,
    documents: call.documents,
    ...(call.topN ? { topN: call.topN } : {}),
    ...(call.signal ? { abortSignal: call.signal } : {})
  });
  return {
    ranking: result.ranking.map((ranked) => ({
      index: ranked.originalIndex,
      score: ranked.score,
      document: ranked.document
    }))
  };
}
