import type { ModelContentPart, ModelRouter, ModelSpecRef } from '#/agent/model/index.ts';
import type { Tool } from '#/capabilities/tools/types.ts';

import { realpath } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';

import { resolveSpec } from '#/agent/model/index.ts';
import { VISION_DEFAULT_PROMPT as DEFAULT_PROMPT } from '#/agent/prompts/short-text.ts';
import { assertPathWithinRoots } from '#/capabilities/tools/security.ts';
import { toolResult } from '#/capabilities/tools/types.ts';

export interface VisionDeps {
  model: ModelRouter;
  /** Vision model spec; a thunk hot-reloads role-assignment edits. */
  defaultModel: ModelSpecRef;
}

const visionInput = z.object({
  image: z.string().min(1).describe('The image to analyze: a local path, http(s) URL, or data URI'),
  prompt: z.string().optional().describe('What to ask about the image (defaults to a general description)')
});
type VisionInput = z.infer<typeof visionInput>;

const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

async function toImagePart(image: string, roots: string[] | undefined): Promise<ModelContentPart> {
  if (image.startsWith('data:')) return { type: 'image', image };
  if (image.startsWith('http://') || image.startsWith('https://')) return { type: 'image', image: new URL(image) };

  // Lexical check first, then realpath + re-check to catch symlink escapes.
  const resolved = assertPathWithinRoots(image, roots);
  const realRoots = roots ? await Promise.all(roots.map((r) => realpath(r).catch(() => r))) : undefined;
  const real = await realpath(resolved);
  assertPathWithinRoots(real, realRoots);
  const bytes = await Bun.file(real).bytes();
  return { type: 'image', image: bytes, mediaType: MEDIA_TYPES[extname(real).toLowerCase()] ?? 'image/png' };
}

export function createVisionTool(deps: VisionDeps): Tool<VisionInput, { text: string }> {
  return {
    name: 'vision_analyze',
    description:
      'Analyze an image (local path, http(s) URL, or data URI) with an optional prompt, returning a text description. Requires a vision-capable model.',
    scopes: [{ resource: 'fs:read' }],
    inputSchema: visionInput,
    run: async ({ image, prompt }, ctx) => {
      const imagePart = await toImagePart(image, ctx.sandboxRoots);
      const result = await deps.model.complete({
        model: resolveSpec(deps.defaultModel) ?? '',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt ?? DEFAULT_PROMPT }, imagePart] }]
      });
      return toolResult({ text: result.text });
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<VisionDeps> = (deps) => [createVisionTool(deps)];
