import type { ModelProfile, Provider } from '@monad/home';
import type { PlannedItem } from '../types.ts';

import { ModelProviderType } from '@monad/protocol';

import { addItem, asString, isRecord } from './shared.ts';

function inferProviderForModel(model: string): Provider | null {
  if (/^gpt-|^o\d|^chatgpt-/i.test(model)) return { id: 'openai', label: 'OpenAI', type: ModelProviderType.OpenAI };
  if (/claude/i.test(model)) return { id: 'anthropic', label: 'Anthropic', type: ModelProviderType.Anthropic };
  if (/gemini/i.test(model)) return { id: 'google', label: 'Google', type: ModelProviderType.Google };
  if (/deepseek/i.test(model)) return { id: 'deepseek', label: 'DeepSeek', type: ModelProviderType.DeepSeek };
  if (/qwen|qwq/i.test(model)) return { id: 'openrouter', label: 'OpenRouter', type: ModelProviderType.OpenRouter };
  return null;
}

function providerTypeFromName(name: string): ModelProviderType | null {
  const normalized = name.toLowerCase().replace(/[_\s]+/g, '-');
  const direct = Object.values(ModelProviderType).find((p) => p === normalized);
  if (direct) return direct;
  if (normalized === 'anthropic') return ModelProviderType.Anthropic;
  if (normalized === 'openai') return ModelProviderType.OpenAI;
  if (normalized === 'google' || normalized === 'gemini') return ModelProviderType.Google;
  if (normalized === 'openrouter') return ModelProviderType.OpenRouter;
  if (normalized === 'ollama') return ModelProviderType.Ollama;
  return null;
}

function providerFromId(id: string, raw?: unknown): Provider | null {
  const type = providerTypeFromName(id);
  if (!type) return null;
  const baseUrl = isRecord(raw)
    ? (asString(raw.baseUrl) ?? asString(raw.base_url) ?? asString(raw.api_base))
    : undefined;
  return {
    id,
    label: isRecord(raw) ? (asString(raw.label) ?? asString(raw.name) ?? id) : id,
    type,
    ...(baseUrl ? { baseUrl } : {})
  };
}

export function addModelProfileFromExternal(
  items: PlannedItem[],
  source: string,
  targetPrefix: string,
  model: string,
  providerId?: string,
  makeDefault = false
): void {
  const provider = providerId ? providerFromId(providerId) : inferProviderForModel(model);
  if (!provider) {
    addItem(items, {
      category: 'modelProfiles',
      source,
      target: `${targetPrefix}.default`,
      action: 'manual',
      reason: `model "${model}" does not identify a supported monad provider`,
      payload: { kind: 'manual' },
      risk: 'medium',
      summary: providerId ? `provider=${providerId} model=${model}` : `model=${model}`
    });
    return;
  }
  const modelId = model.includes('/') ? (model.split('/').pop() ?? model) : model;
  const profile: ModelProfile = {
    alias: `${targetPrefix}-${modelId}`.replace(/[^A-Za-z0-9_.-]+/g, '-'),
    routes: { chat: { provider: provider.id, modelId } },
    params: {},
    fallbacks: []
  };
  addItem(items, {
    category: 'modelProviders',
    source,
    target: provider.id,
    action: 'add',
    reason: `inferred provider "${provider.id}" from external model settings`,
    payload: { kind: 'modelProvider', provider }
  });
  addItem(items, {
    category: 'modelProfiles',
    source,
    target: profile.alias,
    action: 'add',
    reason: 'external default model can be represented as a monad model profile',
    payload: { kind: 'modelProfile', profile, makeDefault }
  });
}

export function providerFromRecord(name: string, raw: unknown): Provider | null {
  if (!isRecord(raw)) return null;
  const type = providerTypeFromName(asString(raw.type) ?? asString(raw.provider) ?? name);
  const known = Object.values(ModelProviderType).find((p) => p === type);
  if (!known) return null;
  const baseUrl = asString(raw.baseUrl) ?? asString(raw.base_url);
  return {
    id: asString(raw.id) ?? name,
    label: asString(raw.label) ?? name,
    type: known,
    ...(baseUrl ? { baseUrl } : {})
  };
}
