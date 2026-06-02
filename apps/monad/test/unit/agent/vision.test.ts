import type { ToolContext } from '#/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ModelContentPart, type ModelRequest, type ModelResult, type ModelRouter } from '#/agent/index.ts';
import { createVisionTool } from '#/capabilities/tools/registry/vision.ts';

/** A model that records the last request and returns a fixed analysis. */
function recordingModel(): { model: ModelRouter; last: () => ModelRequest | undefined } {
  let last: ModelRequest | undefined;
  return {
    model: {
      async *stream() {}, // vision_analyze uses complete(), not stream()
      async complete(req: ModelRequest): Promise<ModelResult> {
        last = req;
        return { text: 'analysis', finishReason: 'stop' };
      }
    },
    last: () => last
  };
}

const ctx: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };
const partsOf = (req: ModelRequest): ModelContentPart[] => {
  const content = req.messages[0]?.content;
  if (!Array.isArray(content)) throw new Error('expected multimodal content');
  return content;
};

// splitSystem (the model-layer multimodal bridge) is tested with the adapter in
// @monad/atoms — see packages/atoms/test/providers.test.ts.

// ── vision_analyze tool ──────────────────────────────────────────────────────

test('vision_analyze sends a multimodal message and returns the model text', async () => {
  const { model, last } = recordingModel();
  const tool = createVisionTool({ model, defaultModel: 'm' });
  const out = await tool.run({ image: 'data:image/png;base64,AAA', prompt: 'what is this' }, ctx);
  expect(out.metadata.text).toBe('analysis');
  const parts = partsOf(last() as ModelRequest);
  expect(parts[0]).toEqual({ type: 'text', text: 'what is this' });
  expect(parts[1]).toEqual({ type: 'image', image: 'data:image/png;base64,AAA' });
});

test('vision_analyze defaults the prompt and passes a URL through for http(s) images', async () => {
  const { model, last } = recordingModel();
  const tool = createVisionTool({ model, defaultModel: 'm' });
  await tool.run({ image: 'https://x.test/p.png' }, ctx);
  const parts = partsOf(last() as ModelRequest);
  const img = parts[1] as { type: 'image'; image: URL };
  expect(img.image.toString()).toBe('https://x.test/p.png');
});

test('vision_analyze reads a local image within the sandbox as bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-vision-'));
  try {
    const file = join(dir, 'pic.png');
    await writeFile(file, new Uint8Array([1, 2, 3, 4]));
    const { model, last } = recordingModel();
    const tool = createVisionTool({ model, defaultModel: 'm' });
    await tool.run({ image: file }, { sessionId: 's', sandboxRoots: [dir], log: () => {} });
    const img = partsOf(last() as ModelRequest)[1] as { type: 'image'; image: Uint8Array; mediaType: string };
    expect(img.image).toBeInstanceOf(Uint8Array);
    expect(img.mediaType).toBe('image/png');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('vision_analyze rejects a local image outside the sandbox', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-vision-'));
  try {
    const tool = createVisionTool({ model: recordingModel().model, defaultModel: 'm' });
    await expect(
      tool.run({ image: '/etc/hosts' }, { sessionId: 's', sandboxRoots: [dir], log: () => {} })
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('vision_analyze rejects empty image input', () => {
  const tool = createVisionTool({ model: recordingModel().model, defaultModel: 'm' });
  expect(tool.inputSchema?.safeParse({ prompt: 'x' }).success).toBe(false);
});
