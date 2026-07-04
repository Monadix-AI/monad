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
  // Hermes has NO persistent app-server backend (`hermes serve` is not a real command), so a managed
  // project member runs as `cli-oneshot`: the daemon spawns `hermes --yolo -z <directive>` per turn.
  // `--yolo` lets it run its terminal toolset autonomously (needed to invoke the `monad project
  // post/ask/read` wrapper on PATH). The managed prompt is prepended to each directive by the host
  // (cli-oneshot has no session.start to carry developer instructions).
  managedRuntime: {
    launchMode: () => 'cli-oneshot'
  },
  oneshot: {
    turnArgs: (input) => ['--yolo', '-z', input]
  },
  protocol: hermesAppServerProtocol
});
