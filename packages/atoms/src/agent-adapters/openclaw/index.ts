import type { NativeCliProviderAdapter } from '@monad/sdk-atom';

import { makeAppServerCliAdapter } from '../app-server-jsonrpc.ts';
import { openClawAppServerProtocol } from './app-server.ts';

// OpenClaw ships no models-list command; these are the models its docs advertise for `--model`.
// Kept as a small fallback list (an operator can override via the agent's modelOptions).
const OPENCLAW_SUPPORTED_MODELS = ['openclaw-default'];

export const openClawNativeCliAdapter: NativeCliProviderAdapter = makeAppServerCliAdapter({
  provider: 'openclaw',
  productIcon: 'openclaw',
  label: 'OpenClaw',
  bin: 'openclaw',
  homeConfigDir: '.openclaw',
  appServerSubcommand: 'gateway',
  models: OPENCLAW_SUPPORTED_MODELS,
  installHint: 'Install OpenClaw, then sign in with openclaw auth.',
  installUrl: 'https://docs.openclaw.ai',
  authStatusArgs: ['status'],
  managedRuntime: {
    launchMode: () => 'app-server',
    usesDeveloperInstructions: true
  },
  protocol: openClawAppServerProtocol
});
