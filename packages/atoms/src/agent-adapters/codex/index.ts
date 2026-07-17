import type { ExternalAgentProviderAdapter } from '@monad/sdk-atom';

import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { parseStructuredAuthState } from '../adapter-shared.ts';
import { externalAgentAdapterSettings } from '../settings.ts';
import { createCodexSettingsImport } from '../settings-import/index.ts';
import { parseCodexSessionJsonl } from './events.ts';
import { codexHistoryPageOutput, readCodexHistoryOutput } from './history.ts';
import {
  buildCodexAuthLaunch,
  buildCodexLaunch,
  CODEX_APP_BIN,
  CODEX_APP_SERVER_TRANSPORTS,
  CODEX_NON_INTERACTIVE_ENV,
  CODEX_SUPPORTED_MODELS,
  codexManagedMcpConfigArgs,
  parseCodexArgumentSupport,
  parseCodexModelOptions
} from './launch.ts';
import { codexObservationProjection } from './observation/index.ts';
import {
  initializeCodex,
  interruptCodex,
  requestCodexHistoryPage,
  resizeCodex,
  resolveCodexApproval,
  sendCodexInput,
  steerCodex,
  stopCodex
} from './runtime.ts';

export const codexExternalAgentAdapter: ExternalAgentProviderAdapter = {
  provider: 'codex',
  productIcon: 'codex',
  label: 'Codex',
  observation: codexObservationProjection,
  settings: () =>
    externalAgentAdapterSettings({
      launchModes: ['pty', 'app-server', 'remote-control'],
      appServerTransports: [...CODEX_APP_SERVER_TRANSPORTS]
    }),
  settingsImport: createCodexSettingsImport(),
  // ACP delivery variant: same Codex agent, launched as an external ACP sub-agent via the codex-acp
  // wrapper. Version-pinned so `npx -y <pkg>@<ver>` resolves a known build, not a silent `latest`.
  acp: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@1.0.0'],
    env: { OPENAI_API_KEY: '${env:' + 'OPENAI_API_KEY}' }
  },
  managedRuntime: {
    launchMode: () => 'app-server',
    env: () => ({ ...CODEX_NON_INTERACTIVE_ENV }),
    mcpConfigArgs: (ctx) => codexManagedMcpConfigArgs(ctx.monadCliEntry, ctx.env),
    usesManagedMcpBridge: true,
    usesDeveloperInstructions: true
  },
  detect(probes = defaultBinProbes) {
    const codexBin = resolveBinary('codex', [CODEX_APP_BIN], probes);
    const installed = codexBin !== undefined;
    return {
      id: 'codex',
      label: codexExternalAgentAdapter.label,
      provider: 'codex',
      productIcon: codexExternalAgentAdapter.productIcon,
      command: 'codex',
      args: [],
      modelOptions: codexExternalAgentAdapter.listSupportedModels(),
      defaultLaunchMode: 'pty',
      supportedLaunchModes: ['pty', 'app-server', 'remote-control'],
      supportedAppServerTransports: [...CODEX_APP_SERVER_TRANSPORTS],
      installHint: 'Install Codex CLI or Codex.app, then sign in with codex login.',
      installUrl: 'https://developers.openai.com/codex/cli',
      installed,
      resolvedBinPath: codexBin,
      capabilities: {
        auth: 'pty',
        history: 'paged',
        resume: 'structured',
        approval: 'provider-owned',
        approvalProxy: true,
        settingsImport: true
      }
    };
  },
  resolveCommand(command, probes = defaultBinProbes) {
    return resolveBinary(command, command === 'codex' ? [CODEX_APP_BIN] : [], probes);
  },
  listSupportedModels(agent) {
    return agent?.modelOptions?.length ? agent.modelOptions : CODEX_SUPPORTED_MODELS;
  },
  modelOptions(agent) {
    return {
      launch: buildCodexAuthLaunch(agent, ['debug', 'models', '--bundled']),
      parse: (output) => parseCodexModelOptions(output)
    };
  },
  buildLaunch: buildCodexLaunch,
  buildAuthLaunch(agent) {
    return buildCodexAuthLaunch(agent, ['login']);
  },
  buildAuthStatusLaunch(agent) {
    return buildCodexAuthLaunch(agent, ['login', 'status']);
  },
  authStatus(agent) {
    return {
      launch: buildCodexAuthLaunch(agent, ['login', 'status']),
      parse: (output, exitCode) => codexExternalAgentAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildCodexAuthLaunch(agent, ['debug', 'models', '--bundled']),
      parse: (output) => parseCodexArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    if (exitCode === 0) return 'authenticated';
    if (exitCode === 1) return 'unauthenticated';
    return 'unknown';
  },
  initialize: initializeCodex,
  parseOutput: parseCodexSessionJsonl,
  requestHistoryPage: requestCodexHistoryPage,
  historyPageOutput: codexHistoryPageOutput,
  historyOutput: readCodexHistoryOutput,
  sendInput: sendCodexInput,
  supportsApprovalResolution: (launchMode) => launchMode === 'app-server',
  resolveApproval: resolveCodexApproval,
  interrupt: interruptCodex,
  steer: steerCodex,
  resize: resizeCodex,
  stop: stopCodex
};
