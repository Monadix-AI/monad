import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ImageRequest, type ImageResult, type ModelRouter } from '#/agent/index.ts';
import { createImageTool } from '#/capabilities/tools/registry/image.ts';

/** A router whose generateImage returns fixed bytes and records the request. */
function imageRouter(
  bytes: Uint8Array,
  opts?: { mediaType?: string; capture?: (req: ImageRequest) => void }
): ModelRouter {
  return {
    async *stream() {},
    async complete() {
      return { text: '' };
    },
    async generateImage(req: ImageRequest): Promise<ImageResult> {
      opts?.capture?.(req);
      return { image: bytes, mediaType: opts?.mediaType ?? 'image/png' };
    }
  };
}

/** A router without image support. */
const textOnlyRouter: ModelRouter = {
  async *stream() {},
  async complete() {
    return { text: '' };
  }
};

const ctxNoSandbox: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };

test('image_generate writes the image into the sandbox and returns its path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-image-'));
  try {
    let seen: ImageRequest | undefined;
    const tool = createImageTool({
      router: imageRouter(new Uint8Array([1, 2, 3]), {
        capture: (r) => {
          seen = r;
        }
      }),
      defaultImageModel: 'openai:dall-e-3'
    });
    const out = await tool.run({ prompt: 'a cat' }, { sessionId: 's', sandboxRoots: [dir], log: () => {} });

    expect(seen?.model).toBe('openai:dall-e-3');
    expect(seen?.prompt).toBe('a cat');
    expect(out.metadata.bytes).toBe(3);
    expect(out.metadata.mediaType).toBe('image/png');
    expect(out.metadata.path.startsWith(dir)).toBe(true);
    expect(await Bun.file(out.metadata.path).bytes()).toEqual(new Uint8Array([1, 2, 3]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a per-call model overrides the configured default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-image-'));
  try {
    let seen: ImageRequest | undefined;
    const tool = createImageTool({
      router: imageRouter(new Uint8Array([9]), {
        capture: (r) => {
          seen = r;
        }
      }),
      defaultImageModel: 'openai:dall-e-3'
    });
    await tool.run(
      { prompt: 'x', model: 'openai:gpt-image-1' },
      { sessionId: 's', sandboxRoots: [dir], log: () => {} }
    );
    expect(seen?.model).toBe('openai:gpt-image-1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('image_generate errors when no image model is configured', async () => {
  const tool = createImageTool({ router: imageRouter(new Uint8Array()) });
  await expect(tool.run({ prompt: 'x' }, ctxNoSandbox)).rejects.toThrow(/no image model/);
});

test('image_generate errors when the router has no image support', async () => {
  const tool = createImageTool({ router: textOnlyRouter, defaultImageModel: 'openai:dall-e-3' });
  await expect(tool.run({ prompt: 'x' }, ctxNoSandbox)).rejects.toThrow(/not supported/);
});

test('image_generate schema rejects an empty prompt', () => {
  const tool = createImageTool({ router: imageRouter(new Uint8Array()) });
  expect(tool.inputSchema?.safeParse({}).success).toBe(false);
});
