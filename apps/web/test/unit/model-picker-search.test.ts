import { expect, test } from 'bun:test';

import {
  filterModelsForPicker,
  modelMatchesQuery,
  modelPickerPriceSummary,
  renderHighlightedModelText
} from '../../src/features/studio/model-settings/model-picker';

test('model search matches query segments across model label and id', () => {
  const model = { id: 'google/gemini-3.5-pro', label: 'Gemini 3.5 Pro' };

  expect(modelMatchesQuery(model, 'gemini pro')).toBe(true);
  expect(modelMatchesQuery(model, 'google pro')).toBe(true);
  expect(modelMatchesQuery(model, 'gemini ultra')).toBe(false);
});

test('highlight rendering marks every matched query segment', () => {
  const parts = renderHighlightedModelText('Gemini 3.5 Pro', 'gemini pro');

  expect(parts).toEqual([
    { text: 'Gemini', match: true },
    { text: ' 3.5 ', match: false },
    { text: 'Pro', match: true }
  ]);
});

test('model picker search only shows matching models', () => {
  const models = [
    { id: 'openai/gpt-4.1', label: 'GPT 4.1' },
    { id: 'google/gemini-3.5-pro', label: 'Gemini 3.5 Pro' },
    { id: 'anthropic/claude-sonnet-4', label: 'Claude Sonnet 4' }
  ];

  expect(filterModelsForPicker(models, 'gemini')).toEqual([models[1]]);
  expect(filterModelsForPicker(models, 'claude sonnet')).toEqual([models[2]]);
  expect(filterModelsForPicker(models, '')).toEqual(models);
});

test('model picker price summary uses the same units as provider model details', () => {
  expect(
    modelPickerPriceSummary({
      units: [{ label: 'Image', price: 0.04, unit: 'image' }]
    })
  ).toBe('$0.04/image');
  expect(modelPickerPriceSummary({ videoSecond: 0.08 })).toBe('$0.08/seconds');
});
