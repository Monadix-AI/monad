import type { ModelRouter, ModelSpecRef } from '#/agent/model/index.ts';
import type { Tool } from '#/capabilities/tools/types.ts';

import { join } from 'node:path';
import { z } from 'zod';

import { resolveSpec } from '#/agent/model/index.ts';
import { toolResult } from '#/capabilities/tools/types.ts';

export interface TtsToolDeps {
  router: ModelRouter;
  /** Speech model spec; a thunk hot-reloads role-assignment edits. */
  defaultSpeechModel?: ModelSpecRef;
}

const ttsInput = z.object({
  text: z.string().min(1).describe('The text to convert to speech'),
  voice: z.string().optional().describe('Voice id/name supported by the speech model'),
  model: z.string().optional().describe('Override speech model as "providerId:modelId"')
});
type TtsInput = z.infer<typeof ttsInput>;

const AUDIO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg'
};

export function createTtsTool(deps: TtsToolDeps): Tool<TtsInput, { path: string; mediaType: string; bytes: number }> {
  return {
    name: 'tts_speak',
    description:
      'Convert text to speech and save the audio into the workspace. Returns the file path. Needs a speech-capable model (default profile speech role, or pass "model" as "providerId:modelId").',
    scopes: [{ resource: 'fs:write' }],
    inputSchema: ttsInput,
    run: async ({ text, voice, model }, ctx) => {
      if (!deps.router.generateSpeech) {
        throw new Error('text-to-speech is not supported by the configured model router');
      }
      const spec = model ?? resolveSpec(deps.defaultSpeechModel);
      if (!spec) {
        throw new Error(
          'no speech model configured — set the default profile speech role or pass "model" ("providerId:modelId")'
        );
      }
      // NOTE: speech synthesis is intentionally NOT recorded in the usage ledger. TTS is priced
      // per-character (not per-token), so the token-based catalog + computeCost can't price it;
      // fabricating a token cost would corrupt the "money is always real" ledger. Deferred until a
      // per-character pricing dimension exists.
      const { audio, mediaType } = await deps.router.generateSpeech({ model: spec, text, ...(voice ? { voice } : {}) });

      const ext = AUDIO_EXT[mediaType] ?? mediaType.split('/')[1] ?? 'mp3';
      const root = ctx.sandboxRoots?.[0] ?? process.cwd();
      const path = join(root, `speech-${Bun.hash(text).toString(16)}.${ext}`);
      await Bun.write(path, audio);
      return toolResult({ path, mediaType, bytes: audio.length });
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<TtsToolDeps> = (deps) => [createTtsTool(deps)];
