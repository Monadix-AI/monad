import type { ModelProvider } from '@monad/sdk-atom';

import { amazonBedrockProviderAtom } from './amazon-bedrock.ts';
import { anthropicProviderAtom } from './anthropic.ts';
import { azureProviderAtom } from './azure.ts';
import { PROVIDER_DESCRIPTOR_LIST } from './catalog.ts';
import { googleProviderAtom } from './google.ts';
import { mistralProviderAtom } from './mistral.ts';
import { openaiProviderAtom } from './openai.ts';
import { makeOpenAICompatibleProvider } from './openai-compatible.ts';
import { openrouterProviderAtom } from './openrouter.ts';
import { vercelGatewayProviderAtom } from './vercel-gateway.ts';

const nativeProviders: ModelProvider[] = [
  anthropicProviderAtom,
  openaiProviderAtom,
  vercelGatewayProviderAtom,
  openrouterProviderAtom,
  googleProviderAtom,
  mistralProviderAtom,
  amazonBedrockProviderAtom,
  azureProviderAtom
];

const compatibleProviders: ModelProvider[] = PROVIDER_DESCRIPTOR_LIST.filter(
  (e) => e.strategy === 'openai-compatible'
).map(makeOpenAICompatibleProvider);

export const builtinModelProviders: ModelProvider[] = [...nativeProviders, ...compatibleProviders];
