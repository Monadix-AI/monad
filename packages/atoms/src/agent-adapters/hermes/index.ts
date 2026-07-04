import type { NativeCliProviderAdapter } from '@monad/sdk-atom';

import { parseStructuredAuthState } from '../adapter-shared.ts';
import { makeAppServerCliAdapter } from '../app-server-jsonrpc.ts';
import { createFrameworkSettingsImport } from '../settings-import.ts';

// Hermes ships no models-list command; this fallback is the model its docs advertise for `--model`.
// An operator can override via the agent's modelOptions.
const HERMES_SUPPORTED_MODELS = ['hermes-4'];

// Hermes has NO persistent app-server / JSON-RPC backend (`hermes serve` is not a real command; only
// interactive `pty` and one-shot `-z`), so it deliberately omits `appServerSubcommand`/`protocol` — its
// launch modes are pty + cli-oneshot only. A managed project member runs as `cli-oneshot`: the daemon
// spawns `hermes --yolo -z <directive>` per turn (`--yolo` = run its terminal toolset autonomously so it
// can invoke the `monad project post/ask/read` wrapper on PATH). The managed prompt is prepended to each
// directive by the host (cli-oneshot has no session.start to carry developer instructions).
const baseHermesNativeCliAdapter = makeAppServerCliAdapter({
  provider: 'hermes',
  productIcon: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  models: HERMES_SUPPORTED_MODELS,
  installHint: 'Install Hermes, then sign in with hermes auth.',
  installUrl: 'https://hermes-agent.nousresearch.com',
  authStatusArgs: ['list'],
  // `hermes auth list` rejects `--json`, so probe plain-text (exit 0 = authenticated) — else a signed-in
  // Hermes would be misreported as unauthenticated and its managed members would falsely require reconnect.
  authStatusJson: false,
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    const normalized = output.trim().toLowerCase();
    if (/no accounts|no credentials|not signed in|not authenticated/.test(normalized)) return 'unauthenticated';
    if (exitCode !== 0) return exitCode === null ? 'unknown' : 'unauthenticated';
    if (!normalized) return 'unknown';
    return 'authenticated';
  },
  managedRuntime: {
    launchMode: () => 'cli-oneshot'
  },
  oneshot: {
    turnArgs: (input) => ['--yolo', '-z', input]
  }
});

export const hermesNativeCliAdapter: NativeCliProviderAdapter = {
  ...baseHermesNativeCliAdapter,
  settingsImport: createFrameworkSettingsImport('hermes', 'Hermes'),
  detect(probes) {
    const preset = baseHermesNativeCliAdapter.detect(probes);
    return {
      ...preset,
      capabilities: {
        auth: preset.capabilities?.auth ?? 'pty',
        history: preset.capabilities?.history ?? 'none',
        resume: preset.capabilities?.resume ?? 'pty',
        approval: preset.capabilities?.approval ?? 'provider-owned',
        settingsImport: true
      }
    };
  }
};
