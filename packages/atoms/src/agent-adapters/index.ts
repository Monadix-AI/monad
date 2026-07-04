import type { NativeCliProviderAdapter } from '@monad/sdk-atom';

import { claudeCodeNativeCliAdapter } from './claude-code/index.ts';
import { codexNativeCliAdapter } from './codex/index.ts';
import { geminiNativeCliAdapter } from './gemini/index.ts';
import { qwenNativeCliAdapter } from './qwen/index.ts';

export { claudeCodeNativeCliAdapter, codexNativeCliAdapter, geminiNativeCliAdapter, qwenNativeCliAdapter };

/** The built-in native coding-CLI agent adapters, registered as `agent-adapter` atoms. */
export const builtinAgentAdapters: NativeCliProviderAdapter[] = [
  codexNativeCliAdapter,
  claudeCodeNativeCliAdapter,
  geminiNativeCliAdapter,
  qwenNativeCliAdapter
];
