// Self-describing metadata for the first-party providers. This is the SOURCE OF TRUTH for the
// built-in catalog — protocol holds only the type/enum, not this data. The daemon assembles the
// provider catalog (for the UI/CLI) from registered providers' `descriptor`, so a third-party
// provider (which carries its own descriptor) is as discoverable as these.

import type { ModelProviderDescriptor } from '@monad/sdk-atom';

const GENERIC_KEY_PLACEHOLDER = 'your-api-key';

export const PROVIDER_DESCRIPTORS = {
  anthropic: {
    type: 'anthropic',
    label: 'Anthropic',
    strategy: 'native',
    npmPackage: '@ai-sdk/anthropic',
    keyPlaceholder: 'sk-ant-…'
  },
  openai: {
    type: 'openai',
    label: 'OpenAI',
    strategy: 'native',
    npmPackage: '@ai-sdk/openai',
    defaultBaseUrl: 'https://api.openai.com/v1',
    keyPlaceholder: 'sk-…'
  },
  'vercel-gateway': {
    type: 'vercel-gateway',
    label: 'Vercel AI Gateway',
    strategy: 'native',
    npmPackage: '@ai-sdk/gateway',
    needsUrl: true,
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  openrouter: {
    type: 'openrouter',
    label: 'OpenRouter',
    strategy: 'native',
    npmPackage: '@ai-sdk/openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    keyPlaceholder: 'sk-or-…'
  },
  google: {
    type: 'google',
    label: 'Google Gemini',
    strategy: 'native',
    npmPackage: '@ai-sdk/google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyPlaceholder: 'AIza…'
  },
  mistral: {
    type: 'mistral',
    label: 'Mistral',
    strategy: 'native',
    npmPackage: '@ai-sdk/mistral',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  'amazon-bedrock': {
    type: 'amazon-bedrock',
    label: 'Amazon Bedrock',
    strategy: 'native',
    npmPackage: '@ai-sdk/amazon-bedrock',
    keyPlaceholder: 'ABSK…',
    extraFields: [{ key: 'region', label: 'AWS Region', placeholder: 'us-east-1', required: true }]
  },
  azure: {
    type: 'azure',
    label: 'Azure OpenAI',
    strategy: 'native',
    npmPackage: '@ai-sdk/azure',
    needsUrl: true,
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  'openai-compatible': {
    type: 'openai-compatible',
    label: 'OpenAI-compatible',
    strategy: 'openai-compatible',
    needsUrl: true,
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  'cloudflare-gateway': {
    type: 'cloudflare-gateway',
    label: 'Cloudflare',
    strategy: 'openai-compatible',
    needsUrl: true,
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  groq: {
    type: 'groq',
    label: 'Groq',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    keyPlaceholder: 'gsk_…'
  },
  xai: {
    type: 'xai',
    label: 'xAI Grok',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.x.ai/v1',
    keyPlaceholder: 'xai-…'
  },
  deepseek: {
    type: 'deepseek',
    label: 'DeepSeek',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    keyPlaceholder: 'sk-…'
  },
  together: {
    type: 'together',
    label: 'Together AI',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  fireworks: {
    type: 'fireworks',
    label: 'Fireworks',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
    keyPlaceholder: 'fw_…'
  },
  cerebras: {
    type: 'cerebras',
    label: 'Cerebras',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    keyPlaceholder: 'csk-…'
  },
  perplexity: {
    type: 'perplexity',
    label: 'Perplexity',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.perplexity.ai',
    keyPlaceholder: 'pplx-…'
  },
  moonshot: {
    type: 'moonshot',
    label: 'Moonshot',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.moonshot.ai/v1',
    keyPlaceholder: 'sk-…'
  },
  zai: {
    type: 'zai',
    label: 'Z.AI',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.z.ai/api/paas/v4',
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  minimax: {
    type: 'minimax',
    label: 'MiniMax',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.minimax.io/v1',
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  nvidia: {
    type: 'nvidia',
    label: 'NVIDIA NIM',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1',
    keyPlaceholder: 'nvapi-…'
  },
  novita: {
    type: 'novita',
    label: 'Novita',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://api.novita.ai/v3/openai',
    keyPlaceholder: GENERIC_KEY_PLACEHOLDER
  },
  ollama: {
    type: 'ollama',
    label: 'Ollama',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    keyPlaceholder: '(local — no key needed)',
    keyOptional: true
  },
  huggingface: {
    type: 'huggingface',
    label: 'Hugging Face',
    strategy: 'openai-compatible',
    defaultBaseUrl: 'https://router.huggingface.co/v1',
    keyPlaceholder: 'hf_…'
  }
} satisfies Record<string, ModelProviderDescriptor>;

export const PROVIDER_DESCRIPTOR_LIST: ModelProviderDescriptor[] = Object.values(PROVIDER_DESCRIPTORS);
