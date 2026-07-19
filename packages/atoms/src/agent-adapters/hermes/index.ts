import type { MeshAgentProviderAdapter } from '@monad/sdk-atom';

import { MeshAgentError } from '@monad/sdk-atom';

import { parseStructuredAuthState } from '../adapter-shared.ts';
import { makeAppServerCliAdapter } from '../app-server-jsonrpc.ts';
import { createProjectedEventSource } from '../event-source.ts';
import { createFrameworkSettingsImport } from '../settings-import/index.ts';
import { hermesAppServerHooks } from './app-server.ts';
import { hermesEventPage, hermesEventPageOutput } from './event-pages.ts';
import { hermesObservationProjection } from './observation.ts';

// Hermes ships no models-list command; this fallback is the model its docs advertise for `--model`.
// An operator can override via the agent's modelOptions.
const HERMES_SUPPORTED_MODELS = ['hermes-4'];

// `hermes serve` was NOT a real command in the previously-installed v0.14.0 (hence the earlier
// pty+cli-oneshot-only cut) but IS real as of v0.18.0 — a genuine JSON-RPC/WebSocket gateway at
// `/api/ws` (see hermes/app-server.ts for the full verification trail). It's wired here as a real,
// working `app-server` launch mode via `appServerHooks` (its event-wrapping quirk doesn't fit a generic
// JSON-RPC dispatcher) + `appServerWs` (non-root path, daemon-assigned port — Hermes's
// `HERMES_DASHBOARD_READY port=N` announce line doesn't match the generic `ws://host:port` scan, and
// its WS auth is a URL query param, not a JSON handshake field).
//
// `managedRuntime` stays on `cli-oneshot` — proven end-to-end with a real LLM turn
// (apps/monad/test/e2e/agent-adapters-real.local.test.ts) — rather than switching the managed-member
// default to the newly-real app-server path untested in that role.
const baseHermesMeshAgentAdapter = makeAppServerCliAdapter({
  provider: 'hermes',
  productIcon: 'hermes',
  label: 'Hermes',
  bin: 'hermes',
  appServerSubcommand: ['serve', '--skip-build'],
  // Confirmed against the official CLI reference (nousresearch/hermes-agent/website/docs/reference/
  // cli-commands.md): "--yolo bypasses dangerous-command approval prompts" across commands, including
  // `serve`/pty — not just the `-z` one-shot mode `oneshotTurnArgs` already uses it for below.
  skipApprovalFlag: '--yolo',
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
  },
  appServerHooks: hermesAppServerHooks,
  appServerWs: {
    path: '/api/ws',
    usesDaemonAssignedPort: true,
    // Hermes's gateway enforces its ws-upgrade token even on loopback (unlike OpenClaw) — a connect with
    // no token is GUARANTEED to be rejected, and a WS-upgrade rejection is indistinguishable from
    // "not listening yet" at the transport layer, so it would otherwise retry for the full app-server
    // startup timeout before surfacing an opaque error. Fail fast here instead, before ever dialing.
    query: (agent) => {
      const token = agent.env?.HERMES_DASHBOARD_SESSION_TOKEN;
      if (!token) {
        throw new MeshAgentError(
          'provider_not_logged_in',
          'Hermes app-server requires agent.env.HERMES_DASHBOARD_SESSION_TOKEN to be configured'
        );
      }
      return { token };
    }
  }
});

export const hermesMeshAgentAdapter: MeshAgentProviderAdapter = {
  ...baseHermesMeshAgentAdapter,
  unsafeArgument: (args) => args.find((arg) => arg === '--yolo'),
  events: createProjectedEventSource({
    provider: 'hermes',
    projection: hermesObservationProjection,
    readPage: async (context, request) => {
      const page = await hermesEventPage({
        ...context,
        request: {
          before: request.before,
          limit: request.limit,
          sortDirection: 'desc',
          itemsView: 'full'
        }
      });
      if (!page) return { state: 'unavailable', reason: 'not-found' };
      if (request.view === 'raw') {
        return {
          state: 'available',
          view: 'raw',
          records: [...page.items].reverse().map((data, index) => ({
            data,
            cursor: `${request.before ?? ''}:${index}`
          })),
          coverage: 'exact',
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
        };
      }
      const output = hermesEventPageOutput({ ...context, page });
      if (!output) return { state: 'unavailable', reason: 'not-found' };
      const source = createProjectedEventSource({ provider: 'hermes', projection: hermesObservationProjection });
      return {
        state: 'available',
        view: 'convenience',
        events: source.projectLive({ id: context.providerSessionRef, output, mode: 'events' }).events,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {})
      };
    }
  }),
  observation: hermesObservationProjection,
  settingsImport: createFrameworkSettingsImport('hermes', 'Hermes'),
  // Hermes's app-server gateway has a real, working `approval.request`/`approval.respond` channel
  // (see hermes/app-server.ts's `resolveHermesApproval`) — transport-agnostic, so ws vs stdio doesn't
  // matter here, only launch mode does. But `managedRuntime.launchMode` above pins managed members to
  // `cli-oneshot` (untested in the app-server role for that role), which has no channel at all. So
  // `capabilities.approvalProxy` deliberately stays unset below — the simple per-template UI toggle
  // would be misleading for the common case — while this still lets a member whose `launchMode` is
  // explicitly overridden to `app-server` (managedProjectLaunchMode respects that override) correctly
  // delegate its approvals instead of silently staying full-auto.
  supportsApprovalResolution: (launchMode) => launchMode === 'app-server',
  detect(probes) {
    const preset = baseHermesMeshAgentAdapter.detect(probes);
    return {
      ...preset,
      capabilities: {
        auth: preset.capabilities?.auth ?? 'pty',
        events: 'provider-owned',
        resume: preset.capabilities?.resume ?? 'pty',
        approval: preset.capabilities?.approval ?? 'provider-owned',
        settingsImport: true
      }
    };
  }
};
