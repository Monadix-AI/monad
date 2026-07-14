import type { TranscribeAudioRequest } from '@monad/protocol';
import type { ModelContext, ModelDeps } from '#/handlers/settings/model/context.ts';

import { definePrompt } from '#/agent/prompt-template.ts';
import { resolveModelRole } from '#/config/resolve.ts';
import { HandlerError } from '#/handlers/handler-error.ts';
import transcriptionCleanupSystemPath from '../prompts/transcription-cleanup-system.prompt.md' with { type: 'file' };
import transcriptionCleanupUserPath from '../prompts/transcription-cleanup-user.prompt.md' with { type: 'file' };

const TRANSCRIPTION_CLEANUP_SYSTEM_PROMPT = await definePrompt({
  id: 'transcription-cleanup.system',
  sourcePath: transcriptionCleanupSystemPath
});
const TRANSCRIPTION_CLEANUP_USER_PROMPT = await definePrompt<{ rawText: string }>({
  id: 'transcription-cleanup.user',
  sourcePath: transcriptionCleanupUserPath
});

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
            { role: 'system', content: TRANSCRIPTION_CLEANUP_SYSTEM_PROMPT.render({}), cache: true },
            { role: 'user', content: TRANSCRIPTION_CLEANUP_USER_PROMPT.render({ rawText }) }
          ]
        });
        return { text: cleaned.text.trim() || rawText };
      } catch {
        return { text: rawText };
      }
    }
  };
}
