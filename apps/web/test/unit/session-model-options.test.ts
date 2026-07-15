import { expect, test } from 'bun:test';

import {
  buildSessionModelProviders,
  nextSessionModelCommand,
  resolveAgentProfileDefault
} from '../../src/features/session/session-model-options';

test('buildSessionModelProviders includes every catalog model grouped by provider', () => {
  expect(
    buildSessionModelProviders(
      [
        { id: 'openai', label: 'OpenAI' },
        { id: 'openrouter', label: 'OpenRouter' }
      ],
      {
        openai: [
          {
            id: 'gpt-5',
            label: 'GPT-5',
            modalities: {
              defaultReasoningEffort: 'medium',
              input: ['text'],
              output: ['text'],
              reasoningEfforts: ['low', 'medium', 'high']
            }
          },
          {
            id: 'gpt-5-probe-failed',
            modalities: {
              defaultReasoningEffort: 'medium',
              input: ['text'],
              output: ['text']
            }
          },
          { id: 'gpt-5-mini' }
        ],
        openrouter: [
          { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' },
          {
            id: 'openai/text-embedding-3-small',
            label: 'Text Embedding 3 Small',
            modalities: { input: ['text'], output: ['embedding'] }
          }
        ]
      }
    )
  ).toEqual([
    {
      label: 'OpenAI',
      models: [
        {
          displayName: 'GPT-5',
          effort: 'medium',
          efforts: ['low', 'medium', 'high'],
          label: 'GPT-5',
          value: 'openai:gpt-5'
        },
        {
          displayName: 'gpt-5-probe-failed',
          label: 'gpt-5-probe-failed',
          value: 'openai:gpt-5-probe-failed'
        },
        { displayName: 'gpt-5-mini', label: 'gpt-5-mini', value: 'openai:gpt-5-mini' }
      ],
      value: 'openai'
    },
    {
      label: 'OpenRouter',
      models: [
        {
          displayName: 'Claude Sonnet 4',
          label: 'Claude Sonnet 4',
          value: 'openrouter:anthropic/claude-sonnet-4'
        }
      ],
      value: 'openrouter'
    }
  ]);
});

test('resolveAgentProfileDefault prefers the agent profile and falls back to the configured default', () => {
  const profiles = [
    { alias: 'balanced', routes: { chat: { provider: 'openai', modelId: 'gpt-5' } }, params: {}, fallbacks: [] },
    { alias: 'coding', routes: { chat: { provider: 'anthropic', modelId: 'claude-code' } }, params: {}, fallbacks: [] }
  ];

  expect(resolveAgentProfileDefault(profiles, 'balanced', 'coding')?.alias).toBe('coding');
  expect(resolveAgentProfileDefault(profiles, 'balanced', 'missing')?.alias).toBe('balanced');
});

test('nextSessionModelCommand only emits a command when the model changes', () => {
  const inherited = { effectiveModel: 'openai:gpt-5', override: undefined };
  const overridden = { effectiveModel: 'openai:gpt-5', override: 'openai:gpt-5' };

  expect(nextSessionModelCommand(inherited, { type: 'model', value: 'openai:gpt-5' })).toBeNull();
  expect(nextSessionModelCommand(inherited, { type: 'model', value: '' })).toBeNull();
  expect(nextSessionModelCommand(inherited, { type: 'profile' })).toBeNull();
  expect(nextSessionModelCommand(overridden, { type: 'profile' })).toBe('/model inherit');
  expect(nextSessionModelCommand(inherited, { type: 'model', value: 'anthropic:claude-sonnet-4' })).toBe(
    '/model anthropic:claude-sonnet-4'
  );
});
