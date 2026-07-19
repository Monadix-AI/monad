import type { MeshAgentProviderAdapter } from '@monad/sdk-atom';

import { createProjectedEventSource } from '../event-source.ts';
import { makeGatewayCliAdapter } from '../legacy/gateway-cli-adapter.ts';
import { createFrameworkSettingsImport } from '../settings-import/index.ts';
import { openClawGatewayHooks } from './gateway/index.ts';
import { openClawObservationProjection } from './observation.ts';

// OpenClaw ships no models-list command; these are the models its docs advertise for `--model`.
// Kept as a small fallback list (an operator can override via the agent's modelOptions).
const OPENCLAW_SUPPORTED_MODELS = ['openclaw-default'];

// OpenClaw has NO CLI flag or env var that bypasses exec approvals (previously this adapter appended
// a nonexistent `--auto-approve` — removed via the shared factory's `skipApprovalFlag` opt-in, which
// OpenClaw deliberately omits). Its docs (docs.openclaw.ai/tools/exec-approvals) say the only way is
// its own config (`tools.exec.security`/`ask`) plus a host-local approvals file
// (`defaults.askFallback` — docs.openclaw.ai/gateway/configuration), and `OPENCLAW_HOME`/
// `OPENCLAW_STATE_DIR` are the documented per-instance overrides for where those live.
//
// This is DELIBERATELY not wired up: OpenClaw's own credential store — `auth-profiles.json` under
// `~/.openclaw/agents/<agentId>/agent/` — "also respects `$OPENCLAW_STATE_DIR`" per its auth docs, so
// redirecting either var to give this agent a private exec-approvals override would silently strand
// the managed session with NO stored auth (it would look for auth-profiles.json in the fresh,
// credential-less directory instead of the operator's real one). A correct fix needs either a
// verified credential-preserving injection (e.g. seeding just the relevant auth-profiles.json into the
// override dir) or hands-on verification against the real binary — not something to guess from docs
// alone given the blast radius (silently broken auth) of getting it wrong.
//
// Net effect: OpenClaw managed agents do NOT currently support autopilot — `allowAutopilot: true` no
// longer sends a broken flag (previously could error/no-op unpredictably), but OpenClaw still prompts
// for approvals it has no channel to resolve while unmanaged. Delegated mode (`allowAutopilot: false`)
// is unaffected and works today via the real `approval.request`/`approval.respond` gateway channel
// (see ./gateway) — this gap is specifically the *autopilot* path. No `managedRuntime.env` hook is
// wired below for this reason — leaving it unset is the correct, safe state until that's resolved.

// Real gateway backend (verified live, see openclaw/gateway) — uses provider-owned hooks
// rather than `protocol` because OpenClaw's wire envelope isn't generic JSON-RPC.
const baseOpenClawMeshAgentAdapter = makeGatewayCliAdapter({
  provider: 'openclaw',
  productIcon: 'openclaw',
  label: 'OpenClaw',
  bin: 'openclaw',
  // `openclaw gateway` alone only prints the subcommand's usage and exits — the real foreground-run
  // command is `gateway run`. `--allow-unconfigured` lets it start without a prior `openclaw onboard`
  // (verified against `openclaw gateway --help`; the daemon otherwise refuses to start a fresh config).
  gatewaySubcommand: ['gateway', 'run', '--allow-unconfigured'],
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
    usesDeveloperInstructions: true
  },
  gatewayHooks: openClawGatewayHooks,
  // OpenClaw's real startup line is `listening on port ${port} 🚀` (confirmed from the shipped
  // package's compiled source) — it never matches the daemon's generic `ws://host:port` announce scan,
  // so a launch would hang until the gateway startup timeout even with a correct wire protocol.
  // `--port` is a real, documented flag (`openclaw gateway --help`), so the daemon just assigns the
  // port itself and dials it directly instead of parsing for one.
  gatewayWs: {
    usesDaemonAssignedPort: true
  }
});

export const openClawMeshAgentAdapter: MeshAgentProviderAdapter = {
  ...baseOpenClawMeshAgentAdapter,
  observation: openClawObservationProjection,
  events: createProjectedEventSource({
    provider: 'openclaw',
    projection: openClawObservationProjection
  }),
  settingsImport: createFrameworkSettingsImport('openclaw', 'OpenClaw'),
  // OpenClaw's managed runtime is its gateway, whose channel projects + resolves approvals —
  // so it can delegate provider approvals to the human. (Hermes shares the factory but has no
  // persistent gateway backend, so it deliberately doesn't opt in.)
  detect(probes) {
    const preset = baseOpenClawMeshAgentAdapter.detect(probes);
    return {
      ...preset,
      capabilities: {
        auth: preset.capabilities?.auth ?? 'pty',
        events: 'provider-owned',
        resume: preset.capabilities?.resume ?? 'pty',
        approval: preset.capabilities?.approval ?? 'provider-owned',
        approvalProxy: true,
        settingsImport: true
      }
    };
  }
};
