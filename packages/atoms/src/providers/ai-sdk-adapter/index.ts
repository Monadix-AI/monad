// The ai-sdk boundary. EVERYTHING that touches the Vercel `ai` SDK lives here — message/tool
// conversion, the streamText/generateText calls, usage normalization. monad's first-party
// providers are thin wrappers that build an ai-sdk LanguageModel and delegate to these helpers;
// the @monad/sdk-atom contract they implement is ai-sdk-free, so a third-party provider can
// ignore this file entirely and implement ModelProvider against any backend.

import type {
  EmbedCall,
  GenerationParams,
  ImageCall,
  ModelCall,
  ModelInfo,
  ModelProvider,
  ModelProviderDescriptor,
  ProviderCredential,
  RerankCall,
  RerankResult,
  ResolvedProviderConfig,
  SpeechCall,
  SpeechResult,
  TranscriptionCall,
  TranscriptionResult,
  UsageLimits,
  VideoCall,
  VideoResult
} from '@monad/sdk-atom';
import type {
  EmbeddingModel,
  ImageModel,
  JSONValue,
  LanguageModel,
  RerankingModel,
  SpeechModel,
  TranscriptionModel
} from 'ai';
import type { VideoModel } from './ai-sdk-media.ts';
import type { RateLimitHeaderStyle } from './ai-sdk-usage.ts';

import { completeViaAiSdk, streamViaAiSdk } from './ai-sdk-generate.ts';
import {
  embedViaAiSdk,
  imageViaAiSdk,
  rerankViaAiSdk,
  speechViaAiSdk,
  transcribeViaAiSdk,
  videoViaAiSdk
} from './ai-sdk-media.ts';

export type { CountTokensInput } from './ai-sdk-messages.ts';

export { renderForCount, splitSystem } from './ai-sdk-messages.ts';
export { buildSdkTools } from './ai-sdk-tools.ts';
export { toUsage } from './ai-sdk-usage.ts';

export type ProviderOpts = Record<string, Record<string, JSONValue>>;

/** What each first-party provider supplies; defineAiSdkProvider wires it into the contract. */
export interface AiSdkProviderSpec {
  type: string;
  descriptor: ModelProviderDescriptor;
  /** Build the ai-sdk language model for this call (reads call.provider / call.credential). */
  build?(call: ModelCall): LanguageModel;
  reasoningOptions?(
    effort: NonNullable<GenerationParams['reasoningEffort']>,
    maxThinkingTokens?: number
  ): ProviderOpts | undefined;
  buildImageModel?(call: ImageCall): ImageModel;
  buildVideoModel?(call: VideoCall): VideoModel;
  buildSpeechModel?(call: SpeechCall): SpeechModel;
  buildTranscriptionModel?(call: TranscriptionCall): TranscriptionModel;
  buildRerankingModel?(call: RerankCall): RerankingModel;
  buildEmbeddingModel?(call: EmbedCall): EmbeddingModel;
  generateVideo?(call: VideoCall): Promise<VideoResult>;
  generateSpeech?(call: SpeechCall): Promise<SpeechResult>;
  transcribe?(call: TranscriptionCall): Promise<TranscriptionResult>;
  rerank?(call: RerankCall): Promise<RerankResult>;
  listModels?(provider: ResolvedProviderConfig, cred?: ProviderCredential): Promise<ModelInfo[]>;
  countTokens?(call: ModelCall): Promise<number | undefined>;
  getUsageLimits?(provider: ResolvedProviderConfig, cred: ProviderCredential): Promise<UsageLimits | undefined>;
  /** Which HTTP header style to capture for rate-limit info. Absent → no capture. */
  rateLimitHeaderStyle?: RateLimitHeaderStyle;
}

/** Wire an ai-sdk-backed spec into the ai-sdk-free ModelProvider contract. */
export function defineAiSdkProvider(spec: AiSdkProviderSpec): ModelProvider {
  return {
    type: spec.type,
    descriptor: spec.descriptor,
    ...(spec.build
      ? {
          stream: (call: ModelCall) => streamViaAiSdk(call, spec),
          complete: (call: ModelCall) => completeViaAiSdk(call, spec)
        }
      : {}),
    ...(spec.buildImageModel
      ? {
          generateImage: (
            (buildImageModel) => (call: ImageCall) =>
              imageViaAiSdk(call, buildImageModel(call))
          )(spec.buildImageModel)
        }
      : {}),
    ...(spec.generateVideo
      ? { generateVideo: spec.generateVideo }
      : spec.buildVideoModel
        ? {
            generateVideo: (
              (buildVideoModel) => (call: VideoCall) =>
                videoViaAiSdk(call, buildVideoModel(call))
            )(spec.buildVideoModel)
          }
        : {}),
    ...(spec.generateSpeech
      ? { generateSpeech: spec.generateSpeech }
      : spec.buildSpeechModel
        ? {
            generateSpeech: (
              (buildSpeechModel) => (call: SpeechCall) =>
                speechViaAiSdk(call, buildSpeechModel(call))
            )(spec.buildSpeechModel)
          }
        : {}),
    ...(spec.transcribe
      ? { transcribe: spec.transcribe }
      : spec.buildTranscriptionModel
        ? {
            transcribe: (
              (buildTranscriptionModel) => (call: TranscriptionCall) =>
                transcribeViaAiSdk(call, buildTranscriptionModel(call))
            )(spec.buildTranscriptionModel)
          }
        : {}),
    ...(spec.rerank
      ? { rerank: spec.rerank }
      : spec.buildRerankingModel
        ? {
            rerank: (
              (buildRerankingModel) => (call: RerankCall) =>
                rerankViaAiSdk(call, buildRerankingModel(call))
            )(spec.buildRerankingModel)
          }
        : {}),
    ...(spec.buildEmbeddingModel
      ? {
          embed: (
            (buildEmbeddingModel) => (call: EmbedCall) =>
              embedViaAiSdk(call, buildEmbeddingModel(call))
          )(spec.buildEmbeddingModel)
        }
      : {}),
    ...(spec.listModels ? { listModels: spec.listModels } : {}),
    ...(spec.countTokens ? { countTokens: spec.countTokens } : {}),
    ...(spec.getUsageLimits ? { getUsageLimits: spec.getUsageLimits } : {})
  };
}
