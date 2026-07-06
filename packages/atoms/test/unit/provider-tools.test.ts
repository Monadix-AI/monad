import type { ToolSpec } from '@monad/sdk-atom';

import { expect, test } from 'bun:test';

import { buildSdkTools } from '../../src/providers/ai-sdk-adapter/index.ts';

const genericSpec: ToolSpec = {
  name: 'fs_read',
  description: 'read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } } }
};

const computerSpec: ToolSpec = {
  name: 'computer',
  description: 'control the computer',
  parameters: { type: 'object', properties: {} },
  providerTool: { anthropic: { type: 'computer_20250124', displayWidthPx: 1280, displayHeightPx: 800 } }
};

test('generic tools build a function tool for any provider', () => {
  const set = buildSdkTools([genericSpec], 'anthropic');
  expect(set?.fs_read).toBeDefined();
  // The generic path is NOT a provider-defined tool.
  expect((set?.fs_read as { type?: string }).type).not.toBe('provider');
});

test('anthropic provider emits the native computer tool when providerTool.anthropic is set', () => {
  const set = buildSdkTools([computerSpec], 'anthropic');
  const t = set?.computer as { type?: string; id?: string };
  expect(t.type).toBe('provider');
  expect(t.id).toBe('anthropic.computer_20250124');
});

test('computer_20251124 maps to its newer native tool', () => {
  const spec: ToolSpec = {
    ...computerSpec,
    providerTool: { anthropic: { type: 'computer_20251124', displayWidthPx: 1280, displayHeightPx: 800 } }
  };
  const set = buildSdkTools([spec], 'anthropic');
  expect((set?.computer as { id?: string }).id).toBe('anthropic.computer_20251124');
});

test('search provider override disables anthropic native web search when ddgs is selected', () => {
  const spec: ToolSpec = {
    name: 'web_search',
    description: 'search the web',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    providerTool: { anthropic: { type: 'web_search_20260209' } }
  };
  const set = buildSdkTools([spec], 'anthropic', 'ddgs');
  const t = set?.web_search as { type?: string; id?: string };
  expect(t.type).not.toBe('provider');
  expect(t.id).toBeUndefined();
});

test('search provider override preserves openai native web search for native mode', () => {
  const spec: ToolSpec = {
    name: 'web_search',
    description: 'search the web',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
    providerTool: { openai: { type: 'web_search_preview' } }
  };
  const set = buildSdkTools([spec], 'openai', 'native');
  const t = set?.web_search as { type?: string; id?: string };
  expect(t.type).toBe('provider');
  expect(t.id).toBe('openai.web_search_preview');
});

test('non-anthropic providers fall back to the generic schema (portable)', () => {
  const set = buildSdkTools([computerSpec], 'openai');
  const t = set?.computer as { type?: string; id?: string };
  // No provider-defined tool — a plain function tool the model can still call.
  expect(t.type).not.toBe('provider');
  expect(t.id).toBeUndefined();
});
