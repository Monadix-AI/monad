import type { ExternalAgentProviderAdapter } from '@monad/sdk-atom';

import { claudeCodeExternalAgentAdapter } from './claude-code/index.ts';
import { codexExternalAgentAdapter } from './codex/index.ts';
import { geminiExternalAgentAdapter } from './gemini/index.ts';
import { hermesExternalAgentAdapter } from './hermes/index.ts';
import { openClawExternalAgentAdapter } from './openclaw/index.ts';
import { qwenExternalAgentAdapter } from './qwen/index.ts';

export { claudeCodeExternalAgentAdapter, createClaudeSdkHistoryPageReader } from './claude-code/index.ts';

/** The built-in native coding-CLI agent adapters, registered as `agent-adapter` atoms. */
export const builtinAgentAdapters: ExternalAgentProviderAdapter[] = [
  codexExternalAgentAdapter,
  claudeCodeExternalAgentAdapter,
  geminiExternalAgentAdapter,
  qwenExternalAgentAdapter,
  openClawExternalAgentAdapter,
  hermesExternalAgentAdapter
];
