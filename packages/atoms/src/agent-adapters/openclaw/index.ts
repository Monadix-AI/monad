import type { NativeCliProviderAdapter } from '@monad/sdk-atom';

import { makeAppServerCliAdapter } from '../app-server-jsonrpc.ts';
import { createFrameworkSettingsImport } from '../settings-import.ts';
import { openClawAppServerProtocol } from './app-server.ts';

// OpenClaw ships no models-list command; these are the models its docs advertise for `--model`.
// Kept as a small fallback list (an operator can override via the agent's modelOptions).
const OPENCLAW_SUPPORTED_MODELS = ['openclaw-default'];

const baseOpenClawNativeCliAdapter = makeAppServerCliAdapter({
  provider: 'openclaw',
  productIcon: 'openclaw',
  label: 'OpenClaw',
  bin: 'openclaw',
  appServerSubcommand: 'gateway',
  models: OPENCLAW_SUPPORTED_MODELS,
  installHint: 'Install OpenClaw, then sign in with openclaw models auth login.',
  installUrl: 'https://docs.openclaw.ai',
  authLaunchArgs: ['models', 'auth', 'login'],
  authStatusArgs: ['status'],
  authStatusLaunchArgs: ['models', 'status', '--check'],
  parseAuthStatus(output, exitCode) {
    const normalized = output.toLowerCase();
    if (exitCode === 0 || exitCode === 2) return 'authenticated';
    if (exitCode === 1) return 'unauthenticated';
    if (/missing auth|not authenticated|not signed in|no auth/.test(normalized)) return 'unauthenticated';
    if (/auth|credential|profile/.test(normalized)) return 'authenticated';
    return 'unknown';
  },
  managedRuntime: {
    launchMode: () => 'app-server',
    usesDeveloperInstructions: true
  },
  protocol: openClawAppServerProtocol
});

export const openClawNativeCliAdapter: NativeCliProviderAdapter = {
  ...baseOpenClawNativeCliAdapter,
  settingsImport: createFrameworkSettingsImport('openclaw', 'OpenClaw'),
  detect(probes) {
    const preset = baseOpenClawNativeCliAdapter.detect(probes);
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
