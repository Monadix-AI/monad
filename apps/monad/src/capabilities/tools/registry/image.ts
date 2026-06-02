import type { ModelRouter, ModelSpecRef } from '@/agent/model/index.ts';
import type { Tool } from '@/capabilities/tools/types.ts';

import { join } from 'node:path';
import { z } from 'zod';

import { resolveSpec } from '@/agent/model/index.ts';
import { toolResult } from '@/capabilities/tools/types.ts';

export interface ImageToolDeps {
  router: ModelRouter;
  /** Image model spec; a thunk hot-reloads role-assignment edits. */
  defaultImageModel?: ModelSpecRef;
}

const imageInput = z.object({
  prompt: z.string().min(1).describe('Text description of the image to generate'),
  model: z.string().optional().describe('Override image model as "providerId:modelId"'),
  size: z.string().optional().describe('Image size, e.g. "1024x1024"')
});
type ImageInput = z.infer<typeof imageInput>;

export function createImageTool(
  deps: ImageToolDeps
): Tool<ImageInput, { path: string; mediaType: string; bytes: number }> {
  return {
    name: 'image_generate',
    description:
      'Generate an image from a text prompt and save it into the workspace. Returns the file path. Needs an image-capable model (default profile image role, or pass "model" as "providerId:modelId").',
    scopes: [{ resource: 'fs:write' }],
    inputSchema: imageInput,
    run: async ({ prompt, model, size }, ctx) => {
      if (!deps.router.generateImage) {
        throw new Error('image generation is not supported by the configured model router');
      }
      const spec = model ?? resolveSpec(deps.defaultImageModel);
      if (!spec) {
        throw new Error(
          'no image model configured — set the default profile image role or pass "model" ("providerId:modelId")'
        );
      }
      // NOTE: image generation is intentionally NOT recorded in the usage ledger. Image models are
      // priced per-image (and per size/quality), not per-token, so the token-based catalog +
      // computeCost can't price them — booking a fabricated token cost would corrupt the
      // "money is always real" ledger. Deferred until a per-image pricing dimension exists.
      const { image, mediaType } = await deps.router.generateImage({ model: spec, prompt, ...(size ? { size } : {}) });

      const ext = (mediaType.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
      const root = ctx.sandboxRoots?.[0] ?? process.cwd();
      const path = join(root, `image-${Bun.hash(prompt).toString(16)}.${ext}`);
      await Bun.write(path, image);
      const metadata = { path, mediaType, bytes: image.length };
      return toolResult(metadata, {
        modelContent: [
          { type: 'text', text: JSON.stringify(metadata) },
          { type: 'image', image, mediaType }
        ]
      });
    }
  };
}

import type { ToolModule } from './contract.ts';
// Uniform module entry.
export const register: ToolModule<ImageToolDeps> = (deps) => [createImageTool(deps)];
