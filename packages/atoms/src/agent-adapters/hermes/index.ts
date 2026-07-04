import type { NativeCliProviderAdapter } from '@monad/sdk-atom';

import { makeAppServerCliAdapter } from '../app-server-jsonrpc.ts';
import { hermesAppServerProtocol } from './app-server.ts';

// Hermes ships no models-list command; this fallback is the model its docs advertise for `--model`.
// An operator can override via the agent's modelOptions.
const HERMES_SUPPORTED_MODELS = ['hermes-4'];

export const hermesNativeCliAdapter: NativeCliProviderAdapter = makeAppServerCliAdapter({
  provider: 'hermes',
  productIcon: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  homeConfigDir: '.hermes',
  appServerSubcommand: 'serve',
  models: HERMES_SUPPORTED_MODELS,
  installHint: 'Install Hermes, then sign in with hermes auth.',
  installUrl: 'https://hermes-agent.nousresearch.com',
  authStatusArgs: ['list'],
  managedRuntime: {
    launchMode: () => 'app-server',
    usesDeveloperInstructions: true
  },
  protocol: hermesAppServerProtocol
});
