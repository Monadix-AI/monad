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

export { buildSdkTools, defineAiSdkProvider, renderForCount, splitSystem, toUsage } from './ai-sdk-adapter.ts';
export { amazonBedrockProviderAtom } from './amazon-bedrock.ts';
export { anthropicProviderAtom } from './anthropic.ts';
export { azureProviderAtom } from './azure.ts';
export { googleProviderAtom } from './google.ts';
export { mistralProviderAtom } from './mistral.ts';
export { openaiProviderAtom } from './openai.ts';
export {
  cloudflareGatewayProviderAtom,
  makeOpenAICompatibleProvider,
  openaiCompatibleProviderAtom
} from './openai-compatible.ts';
export { openrouterProviderAtom } from './openrouter.ts';
export { vercelGatewayProviderAtom } from './vercel-gateway.ts';

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

// Every openai-compatible catalog entry becomes a preset over the bundled adapter.
const compatibleProviders: ModelProvider[] = PROVIDER_DESCRIPTOR_LIST.filter(
  (e) => e.strategy === 'openai-compatible'
).map(makeOpenAICompatibleProvider);

/** All first-party model providers, bundled with the app. Registered into the ModelProviderRegistry
 *  via `builtinAtomPack` — the same atom-kind-gated path as third-party `['provider']` atoms. */
export const builtinModelProviders: ModelProvider[] = [...nativeProviders, ...compatibleProviders];
