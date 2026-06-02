import type { EmbedCall, EmbedResult, ImageCall, ImageResult, SpeechCall, SpeechResult } from '@monad/sdk-atom';
import type { ModelChunk, ModelResult, ModelRouter, ModelUsage, ToolCall } from '@/agent/index.ts';

class MockModelBuilder {
  private readonly chunks: ModelChunk[] = [];

  text(tokens: string[]): this {
    for (const token of tokens) this.chunks.push({ type: 'text', token });
    return this;
  }

  reasoning(tokens: string[]): this {
    for (const token of tokens) this.chunks.push({ type: 'reasoning', token });
    return this;
  }

  toolCall(call: ToolCall): this {
    this.chunks.push({ type: 'tool-call', call });
    return this;
  }

  finish(reason: string): this {
    this.chunks.push({ type: 'finish', reason });
    return this;
  }

  usage(usage: ModelUsage): this {
    this.chunks.push({ type: 'usage', usage });
    return this;
  }

  toolInputDelta(_toolCallId: string, ..._deltas: string[]): this {
    throw new Error('NotImplemented: toolInputDelta — extend @monad/sdk-atom ModelChunk first');
  }

  source(_s: { id: string; url: string; title?: string }): this {
    throw new Error('NotImplemented: source — extend @monad/sdk-atom ModelChunk first');
  }

  file(_data: Uint8Array, _mediaType: string): this {
    throw new Error('NotImplemented: file — extend @monad/sdk-atom ModelChunk first');
  }

  build(): ModelRouter {
    const chunks = [...this.chunks];
    return {
      async *stream() {
        yield* chunks;
      },
      async complete(): Promise<ModelResult> {
        const text = chunks
          .filter((c): c is Extract<ModelChunk, { type: 'text' }> => c.type === 'text')
          .map((c) => c.token)
          .join('');
        const toolCalls = chunks
          .filter((c): c is Extract<ModelChunk, { type: 'tool-call' }> => c.type === 'tool-call')
          .map((c) => c.call);
        const usageChunk = chunks.find((c): c is Extract<ModelChunk, { type: 'usage' }> => c.type === 'usage');
        const finishChunk = chunks.find((c): c is Extract<ModelChunk, { type: 'finish' }> => c.type === 'finish');
        return {
          text,
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(usageChunk ? { usage: usageChunk.usage } : {}),
          finishReason: finishChunk?.reason ?? 'stop'
        };
      }
    };
  }
}

export function buildMockModel(): MockModelBuilder {
  return new MockModelBuilder();
}

export function buildMockImageProvider(image: Uint8Array, mediaType: string) {
  return {
    generateImage: async (_call: ImageCall): Promise<ImageResult> => ({ image, mediaType })
  };
}

export function buildMockSpeechProvider(audio: Uint8Array, mediaType: string) {
  return {
    generateSpeech: async (_call: SpeechCall): Promise<SpeechResult> => ({ audio, mediaType })
  };
}

export function buildMockEmbedProvider(embeddings: number[][]) {
  return {
    embed: async (_call: EmbedCall): Promise<EmbedResult> => ({ embeddings })
  };
}
