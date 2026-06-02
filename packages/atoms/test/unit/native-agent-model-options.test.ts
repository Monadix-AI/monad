import { expect, test } from 'bun:test';

import { parseAntigravityModelOptions } from '../../src/agent-adapters/antigravity/model-options.ts';
import { claudeModelOptions } from '../../src/agent-adapters/claude-code/model-options.ts';
import { parseCodexModelOptions } from '../../src/agent-adapters/codex/launch.ts';
import { GEMINI_SUPPORTED_MODEL_OPTIONS, geminiModelOptions } from '../../src/agent-adapters/gemini/model-options.ts';

test('Antigravity model discovery preserves every versioned CLI model identifier', () => {
  expect(
    parseAntigravityModelOptions(`
gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.1-pro-high
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
`)
  ).toEqual([
    { value: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)' },
    { value: 'gemini-3.6-flash-medium', displayName: 'Gemini 3.6 Flash (Medium)' },
    { value: 'gemini-3.1-pro-high', displayName: 'Gemini 3.1 Pro (High)' },
    { value: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
    { value: 'claude-opus-4-6-thinking', displayName: 'Claude Opus 4.6 (Thinking)' },
    { value: 'gpt-oss-120b-medium', displayName: 'GPT-OSS 120B (Medium)' }
  ]);
});

test('Claude model discovery preserves selectable values and adds resolved versions to display names', () => {
  expect(
    claudeModelOptions([
      {
        value: 'opus[1m]',
        resolvedModel: 'claude-opus-4-8[1m]',
        displayName: 'Opus'
      },
      {
        value: 'default',
        resolvedModel: 'claude-opus-5[1m]',
        displayName: 'Default (recommended)',
        supportsFastMode: true
      },
      {
        value: 'haiku',
        resolvedModel: 'claude-haiku-4-5-20251001',
        displayName: 'Haiku'
      }
    ])
  ).toEqual([
    {
      value: 'opus[1m]',
      displayName: 'Opus (claude-opus-4-8[1m])'
    },
    {
      value: 'default',
      displayName: 'Default (recommended) (claude-opus-5[1m])',
      speeds: ['fast']
    },
    {
      value: 'haiku',
      displayName: 'Haiku (claude-haiku-4-5-20251001)'
    }
  ]);
});

test('Codex model discovery keeps fast tiers scoped to each model', () => {
  expect(
    parseCodexModelOptions(
      JSON.stringify({
        models: [
          {
            slug: 'gpt-fast',
            display_name: 'GPT Fast',
            visibility: 'list',
            additional_speed_tiers: ['fast']
          },
          {
            slug: 'gpt-standard',
            display_name: 'GPT Standard',
            visibility: 'list',
            additional_speed_tiers: []
          }
        ]
      })
    )
  ).toEqual([
    { value: 'gpt-fast', displayName: 'GPT Fast', speeds: ['fast'] },
    { value: 'gpt-standard', displayName: 'GPT Standard' }
  ]);
});

test('Gemini ACP model discovery projects the complete account-specific catalog', () => {
  expect(
    geminiModelOptions({
      models: {
        currentModelId: 'auto',
        availableModels: [
          { modelId: 'auto', name: 'Auto (Gemini 3)' },
          { modelId: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro Preview' },
          { modelId: 'gemini-3-flash-preview', name: 'Gemini 3 Flash Preview' }
        ]
      }
    })
  ).toEqual([
    { value: 'auto', displayName: 'Auto (Gemini 3)' },
    { value: 'gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
    { value: 'gemini-3-flash-preview', displayName: 'Gemini 3 Flash Preview' }
  ]);
});

test('Gemini fallback uses complete documented model identifiers instead of shorthand aliases', () => {
  expect(GEMINI_SUPPORTED_MODEL_OPTIONS).toEqual([
    { value: 'auto', displayName: 'Auto' },
    { value: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
    { value: 'gemini-3.1-flash-lite', displayName: 'Gemini 3.1 Flash Lite' }
  ]);
});
