import type { ToolContext } from '@/capabilities/tools/types.ts';

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ModelRouter, type SpeechRequest, type SpeechResult } from '@/agent/index.ts';
import { createTtsTool } from '@/capabilities/tools/registry/tts.ts';

function speechRouter(
  bytes: Uint8Array,
  opts?: { mediaType?: string; capture?: (req: SpeechRequest) => void }
): ModelRouter {
  return {
    async *stream() {},
    async complete() {
      return { text: '' };
    },
    async generateSpeech(req: SpeechRequest): Promise<SpeechResult> {
      opts?.capture?.(req);
      return { audio: bytes, mediaType: opts?.mediaType ?? 'audio/mpeg' };
    }
  };
}

const textOnlyRouter: ModelRouter = {
  async *stream() {},
  async complete() {
    return { text: '' };
  }
};

const ctxNoSandbox: ToolContext = { sessionId: 's1', sandboxRoots: undefined, log: () => {} };

test('tts_speak synthesizes audio into the sandbox and returns its path (.mp3 for audio/mpeg)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-tts-'));
  try {
    let seen: SpeechRequest | undefined;
    const tool = createTtsTool({
      router: speechRouter(new Uint8Array([1, 2, 3, 4, 5]), {
        capture: (r) => {
          seen = r;
        }
      }),
      defaultSpeechModel: 'openai:tts-1'
    });
    const out = await tool.run(
      { text: 'hello world', voice: 'alloy' },
      { sessionId: 's', sandboxRoots: [dir], log: () => {} }
    );

    expect(seen?.model).toBe('openai:tts-1');
    expect(seen?.text).toBe('hello world');
    expect(seen?.voice).toBe('alloy');
    expect(out.metadata.bytes).toBe(5);
    expect(out.metadata.path.endsWith('.mp3')).toBe(true);
    expect(out.metadata.path.startsWith(dir)).toBe(true);
    expect(await Bun.file(out.metadata.path).bytes()).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a per-call model overrides the configured default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-tts-'));
  try {
    let seen: SpeechRequest | undefined;
    const tool = createTtsTool({
      router: speechRouter(new Uint8Array([9]), {
        capture: (r) => {
          seen = r;
        }
      }),
      defaultSpeechModel: 'openai:tts-1'
    });
    await tool.run(
      { text: 'x', model: 'openai:gpt-4o-mini-tts' },
      { sessionId: 's', sandboxRoots: [dir], log: () => {} }
    );
    expect(seen?.model).toBe('openai:gpt-4o-mini-tts');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tts_speak errors when no speech model is configured', async () => {
  const tool = createTtsTool({ router: speechRouter(new Uint8Array()) });
  await expect(tool.run({ text: 'x' }, ctxNoSandbox)).rejects.toThrow(/no speech model/);
});

test('tts_speak errors when the router has no speech support', async () => {
  const tool = createTtsTool({ router: textOnlyRouter, defaultSpeechModel: 'openai:tts-1' });
  await expect(tool.run({ text: 'x' }, ctxNoSandbox)).rejects.toThrow(/not supported/);
});

test('tts_speak schema rejects empty text', () => {
  const tool = createTtsTool({ router: speechRouter(new Uint8Array()) });
  expect(tool.inputSchema?.safeParse({}).success).toBe(false);
});

test('defaultSpeechModel accepts a thunk and resolves it live (role hot-reload)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'monad-tts-'));
  try {
    let current = 'openai:tts-1';
    const seen: string[] = [];
    const tool = createTtsTool({
      router: speechRouter(new Uint8Array([1]), { capture: (r) => seen.push(r.model) }),
      defaultSpeechModel: () => current // a thunk, like the daemon passes for role hot-reload
    });
    await tool.run({ text: 'a' }, { ...ctxNoSandbox, sandboxRoots: [dir] });
    current = 'openai:tts-2'; // operator changes the speech role mid-session
    await tool.run({ text: 'b' }, { ...ctxNoSandbox, sandboxRoots: [dir] });
    expect(seen).toEqual(['openai:tts-1', 'openai:tts-2']); // second call saw the new model, no rebuild
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
