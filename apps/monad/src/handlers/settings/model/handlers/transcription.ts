import type { TranscribeAudioRequest } from '@monad/protocol';
import type { ModelContext, ModelDeps } from '@/handlers/settings/model/context.ts';

import { resolveModelRole } from '@/config/resolve.ts';
import { HandlerError } from '@/handlers/handler-error.ts';
// `with { type: 'file' }` embeds reliably in bun's --compile binary (unlike new URL+import.meta.url).
import transcriptionCleanupPromptPath from '../prompts/transcription-cleanup-prompt.md' with { type: 'file' };

const TRANSCRIPTION_CLEANUP_PROMPT = (await Bun.file(transcriptionCleanupPromptPath).text()).trim();

function decodeBase64(value: string): Uint8Array {
  try {
    return new Uint8Array(Buffer.from(value, 'base64'));
  } catch {
    throw new HandlerError('invalid', 'model: audio payload is not valid base64');
  }
}

export function createTranscriptionHandlers(ctx: ModelContext, deps: Pick<ModelDeps, 'modelService'>) {
  return {
    async transcribeAudio({ audioBase64, mediaType, language }: TranscribeAudioRequest) {
      const transcribe = deps.modelService.router.transcribe;
      if (!transcribe) {
        throw new HandlerError('invalid', 'model: current model router does not support audio transcription');
      }
      const { cfg } = await ctx.read();
      const model = resolveModelRole(
        cfg.model,
        'transcription',
        cfg.model.default || 'default',
        ctx.lookupCapabilities
      );
      if (!model) throw new HandlerError('invalid', 'model: no transcription model configured');
      const result = await transcribe.call(deps.modelService.router, {
        model,
        audio: decodeBase64(audioBase64),
        ...(mediaType ? { mediaType } : {}),
        ...(language ? { language } : {})
      });
      const rawText = result.text.trim();
      if (!rawText) return { text: result.text };

      const cleanupModel = resolveModelRole(cfg.model, 'fast', cfg.model.default || 'default', ctx.lookupCapabilities);
      if (!cleanupModel) throw new HandlerError('invalid', 'model: no fast model configured for transcription cleanup');
      try {
        const cleaned = await deps.modelService.router.complete({
          model: cleanupModel,
          messages: [
            { role: 'system', content: TRANSCRIPTION_CLEANUP_PROMPT, cache: true },
            { role: 'user', content: `<raw_text>${rawText}</raw_text>` }
          ]
        });
        return { text: cleaned.text.trim() || rawText };
      } catch {
        return { text: rawText };
      }
    }
  };
}
