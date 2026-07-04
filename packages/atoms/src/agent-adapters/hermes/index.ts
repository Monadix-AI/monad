import type { NativeCliProviderAdapter } from '@monad/sdk-atom';

import { makeAppServerCliAdapter } from '../app-server-jsonrpc.ts';

// Hermes ships no models-list command; this fallback is the model its docs advertise for `--model`.
// An operator can override via the agent's modelOptions.
const HERMES_SUPPORTED_MODELS = ['hermes-4'];

// Hermes has NO persistent app-server / JSON-RPC backend (`hermes serve` is not a real command; only
// interactive `pty` and one-shot `-z`), so it deliberately omits `appServerSubcommand`/`protocol` — its
// launch modes are pty + cli-oneshot only. A managed project member runs as `cli-oneshot`: the daemon
// spawns `hermes --yolo -z <directive>` per turn (`--yolo` = run its terminal toolset autonomously so it
// can invoke the `monad project post/ask/read` wrapper on PATH). The managed prompt is prepended to each
// directive by the host (cli-oneshot has no session.start to carry developer instructions).
export const hermesNativeCliAdapter: NativeCliProviderAdapter = makeAppServerCliAdapter({
  provider: 'hermes',
  productIcon: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  models: HERMES_SUPPORTED_MODELS,
  installHint: 'Install Hermes, then sign in with hermes auth.',
  installUrl: 'https://hermes-agent.nousresearch.com',
  authStatusArgs: ['list'],
  managedRuntime: {
    launchMode: () => 'cli-oneshot'
  },
  oneshot: {
    turnArgs: (input) => ['--yolo', '-z', input]
  }
});
