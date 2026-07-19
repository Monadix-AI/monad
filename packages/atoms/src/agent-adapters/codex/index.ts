import type { MeshAgentProviderAdapter } from '@monad/sdk-atom';

import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { parseStructuredAuthState } from '../adapter-shared.ts';
import { createOutputEventSource } from '../event-source.ts';
import { meshAgentAdapterSettings } from '../settings.ts';
import { createCodexSettingsImport } from '../settings-import/index.ts';
import { readCodexEventOutput } from './event-pages.ts';
import {
  buildCodexAuthLaunch,
  CODEX_APP_BIN,
  CODEX_NON_INTERACTIVE_ENV,
  CODEX_SUPPORTED_MODELS,
  codexManagedMcpConfigArgs,
  parseCodexArgumentSupport,
  parseCodexModelOptions
} from './launch.ts';
import { codexObservationProjection } from './observation/index.ts';
import { createCodexSessionRuntime } from './session-runtime.ts';

export const codexMeshAgentAdapter: MeshAgentProviderAdapter = {
  provider: 'codex',
  productIcon: 'codex',
  label: 'Codex',
  observation: codexObservationProjection,
  events: createOutputEventSource({
    provider: 'codex',
    projection: codexObservationProjection,
    readOutput: readCodexEventOutput
  }),
  settings: () => meshAgentAdapterSettings(),
  settingsImport: createCodexSettingsImport(),
  // ACP delivery variant: same Codex agent, launched as an external ACP sub-agent via the codex-acp
  // wrapper. Version-pinned so `npx -y <pkg>@<ver>` resolves a known build, not a silent `latest`.
  acp: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp@1.0.0'],
    env: { OPENAI_API_KEY: '${env:' + 'OPENAI_API_KEY}' },
    loginDirectories: [join(homedir(), '.codex')],
    credentialDirectories: [{ path: join(homedir(), '.codex'), env: 'CODEX_HOME' }],
    authEnvironmentVariables: ['OPENAI_API_KEY']
  },
  managedRuntime: {
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
      label: codexMeshAgentAdapter.label,
      provider: 'codex',
      productIcon: codexMeshAgentAdapter.productIcon,
      command: 'codex',
      args: [],
      modelOptions: codexMeshAgentAdapter.listSupportedModels(),
      installHint: 'Install Codex CLI or Codex.app, then sign in with codex login.',
      installUrl: 'https://developers.openai.com/codex/cli',
      installed,
      resolvedBinPath: codexBin,
      capabilities: {
        auth: 'pty',
        events: 'paged',
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
  createSessionRuntime: createCodexSessionRuntime,
  unsafeArgument: (args) => args.find((arg) => arg === '--dangerously-bypass-approvals-and-sandbox'),
  buildAuthLaunch(agent) {
    return buildCodexAuthLaunch(agent, ['login']);
  },
  buildAuthStatusLaunch(agent) {
    return buildCodexAuthLaunch(agent, ['login', 'status']);
  },
  authStatus(agent) {
    return {
      launch: buildCodexAuthLaunch(agent, ['login', 'status']),
      parse: (output, exitCode) => codexMeshAgentAdapter.parseAuthStatus(output, exitCode)
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
  }
};
