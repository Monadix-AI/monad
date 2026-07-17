import type { ImageCall, RerankCall, SpeechCall, TranscriptionCall, VideoCall } from '@monad/sdk-atom';
import type {
  ImageRequest,
  ImageResult,
  RerankRequest,
  RerankResult,
  SpeechRequest,
  SpeechResult,
  TranscriptionRequest,
  TranscriptionResult,
  VideoRequest,
  VideoResult
} from '../index.ts';
import type { ModelProviderRegistry } from '../provider.ts';
import type { GatewayDeps } from './index.ts';

import {
  buildChain,
  errInfo,
  modelCreds,
  noCredentialsError,
  resolveProvider,
  unsupportedCapabilityError
} from './gateway-routing.ts';

export async function generateImage(
  deps: GatewayDeps,
  registry: ModelProviderRegistry,
  req: ImageRequest
): Promise<ImageResult> {
  const errors: unknown[] = [];
  for (const attempt of buildChain(deps, { model: req.model, messages: [] })) {
    const creds = modelCreds(deps, attempt.provider);
    if (creds.length === 0) {
      errors.push(noCredentialsError(attempt.provider));
      continue;
    }
    const { provider, impl } = resolveProvider(deps, registry, attempt.provider);
    if (!impl.generateImage) {
      errors.push(unsupportedCapabilityError(attempt.provider, 'image generation'));
      continue;
    }
    for (const cred of creds) {
      try {
        const call: ImageCall = {
          modelId: attempt.modelId,
          prompt: req.prompt,
          ...(req.size ? { size: req.size } : {}),
          ...(req.n ? { n: req.n } : {}),
          provider,
          credential: cred,
          fetch: deps.fetch
        };
        const result = await impl.generateImage(call);
        deps.reportCredential?.(attempt.provider, cred.id, true);
        return result;
      } catch (err) {
        deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
        errors.push(err);
      }
    }
  }
  throw new AggregateError(errors, 'gateway: image generation failed');
}

export async function generateSpeech(
  deps: GatewayDeps,
  registry: ModelProviderRegistry,
  req: SpeechRequest
): Promise<SpeechResult> {
  const errors: unknown[] = [];
  for (const attempt of buildChain(deps, { model: req.model, messages: [] })) {
    const creds = modelCreds(deps, attempt.provider);
    if (creds.length === 0) {
      errors.push(noCredentialsError(attempt.provider));
      continue;
    }
    const { provider, impl } = resolveProvider(deps, registry, attempt.provider);
    if (!impl.generateSpeech) {
      errors.push(unsupportedCapabilityError(attempt.provider, 'text-to-speech'));
      continue;
    }
    for (const cred of creds) {
      try {
        const call: SpeechCall = {
          modelId: attempt.modelId,
          text: req.text,
          ...(req.voice ? { voice: req.voice } : {}),
          provider,
          credential: cred,
          fetch: deps.fetch
        };
        const result = await impl.generateSpeech(call);
        deps.reportCredential?.(attempt.provider, cred.id, true);
        return result;
      } catch (err) {
        deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
        errors.push(err);
      }
    }
  }
  throw new AggregateError(errors, 'gateway: speech generation failed');
}

export async function generateVideo(
  deps: GatewayDeps,
  registry: ModelProviderRegistry,
  req: VideoRequest
): Promise<VideoResult> {
  const errors: unknown[] = [];
  for (const attempt of buildChain(deps, { model: req.model, messages: [] })) {
    const creds = modelCreds(deps, attempt.provider);
    if (creds.length === 0) {
      errors.push(noCredentialsError(attempt.provider));
      continue;
    }
    const { provider, impl } = resolveProvider(deps, registry, attempt.provider);
    if (!impl.generateVideo) {
      errors.push(unsupportedCapabilityError(attempt.provider, 'video generation'));
      continue;
    }
    for (const cred of creds) {
      try {
        const call: VideoCall = {
          modelId: attempt.modelId,
          prompt: req.prompt,
          ...(req.image ? { image: req.image } : {}),
          ...(req.mediaType ? { mediaType: req.mediaType } : {}),
          ...(req.aspectRatio ? { aspectRatio: req.aspectRatio } : {}),
          ...(req.resolution ? { resolution: req.resolution } : {}),
          ...(req.duration ? { duration: req.duration } : {}),
          ...(req.fps ? { fps: req.fps } : {}),
          ...(req.n ? { n: req.n } : {}),
          provider,
          credential: cred,
          fetch: deps.fetch
        };
        const result = await impl.generateVideo(call);
        deps.reportCredential?.(attempt.provider, cred.id, true);
        return result;
      } catch (err) {
        deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
        errors.push(err);
      }
    }
  }
  throw new AggregateError(errors, 'gateway: video generation failed');
}

export async function transcribe(
  deps: GatewayDeps,
  registry: ModelProviderRegistry,
  req: TranscriptionRequest
): Promise<TranscriptionResult> {
  const errors: unknown[] = [];
  for (const attempt of buildChain(deps, { model: req.model, messages: [] })) {
    const creds = modelCreds(deps, attempt.provider);
    if (creds.length === 0) {
      errors.push(noCredentialsError(attempt.provider));
      continue;
    }
    const { provider, impl } = resolveProvider(deps, registry, attempt.provider);
    if (!impl.transcribe) {
      errors.push(unsupportedCapabilityError(attempt.provider, 'audio transcription'));
      continue;
    }
    for (const cred of creds) {
      try {
        const call: TranscriptionCall = {
          modelId: attempt.modelId,
          audio: req.audio,
          ...(req.mediaType ? { mediaType: req.mediaType } : {}),
          ...(req.language ? { language: req.language } : {}),
          provider,
          credential: cred,
          fetch: deps.fetch
        };
        const result = await impl.transcribe(call);
        deps.reportCredential?.(attempt.provider, cred.id, true);
        return result;
      } catch (err) {
        deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
        errors.push(err);
      }
    }
  }
  throw new AggregateError(errors, 'gateway: audio transcription failed');
}

export async function rerank(
  deps: GatewayDeps,
  registry: ModelProviderRegistry,
  req: RerankRequest
): Promise<RerankResult> {
  const errors: unknown[] = [];
  for (const attempt of buildChain(deps, { model: req.model, messages: [] })) {
    const creds = modelCreds(deps, attempt.provider);
    if (creds.length === 0) {
      errors.push(noCredentialsError(attempt.provider));
      continue;
    }
    const { provider, impl } = resolveProvider(deps, registry, attempt.provider);
    if (!impl.rerank) {
      errors.push(unsupportedCapabilityError(attempt.provider, 'reranking'));
      continue;
    }
    for (const cred of creds) {
      try {
        const call: RerankCall = {
          modelId: attempt.modelId,
          query: req.query,
          documents: req.documents,
          ...(req.topN ? { topN: req.topN } : {}),
          provider,
          credential: cred,
          fetch: deps.fetch
        };
        const result = await impl.rerank(call);
        deps.reportCredential?.(attempt.provider, cred.id, true);
        return result;
      } catch (err) {
        deps.reportCredential?.(attempt.provider, cred.id, false, errInfo(err));
        errors.push(err);
      }
    }
  }
  throw new AggregateError(errors, 'gateway: reranking failed');
}
