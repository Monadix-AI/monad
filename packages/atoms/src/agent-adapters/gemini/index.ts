import type { MeshAgentView } from '@monad/protocol';
import type {
  MeshAgentProviderAdapter,
  MeshAgentProviderEventContext,
  MeshAgentSessionRuntimeContext,
  SessionEventRuntimeDefinition
} from '@monad/sdk-atom';
import type { LegacyProviderLaunchOptions, LegacyProviderLaunchSpec } from '../legacy/runtime.ts';

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultBinProbes, resolveBinary } from '@monad/sdk-atom';

import { hasFlag, parseJsonObject, parseStructuredAuthState } from '../adapter-shared.ts';
import { parseMeshAgentArgumentSupport } from '../argument-support.ts';
import { readProviderEventFile } from '../event-files.ts';
import { createOutputEventSource } from '../event-source.ts';
import { SessionEventJsonlDriver } from '../session-event-jsonl-driver.ts';
import { meshAgentAdapterSettings } from '../settings.ts';
import { createBasicSettingsImport } from '../settings-import/index.ts';
import { archiveGeminiSession, deleteGeminiSession } from './lifecycle.ts';
import { geminiObservationProjection } from './observation.ts';
import { createGeminiStreamJsonParser, hasGeminiStreamJsonEvents } from './stream-json.ts';

// Unlike codex (`debug models --bundled` prints a JSON catalog) and qwen (models are readable from
// `~/.qwen/settings.json`), the installed `gemini` CLI has no models-list command or flag (`gemini
// --help` documents `-m, --model <string>` with no enumerated choices) and no `@google/genai`/
// `@google/gemini-cli-core` SDK is a dependency here that could supply one. These are tier names
// (Google's own stable per-tier identifiers, not dated snapshots), not a hand-picked version pin, but
// this list can still fall behind when Google ships a new tier. Revisit if gemini-cli ever adds a
// probe-able models command.
const GEMINI_SUPPORTED_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash'];

function geminiManagedEnv(workspace: string): Record<string, string> {
  const settingsFile = join(workspace, 'gemini-system-settings.json');
  writeFileSync(settingsFile, `${JSON.stringify({ context: { loadMemoryFromIncludeDirectories: true } }, null, 2)}\n`, {
    mode: 0o600
  });
  return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settingsFile };
}

function withGeminiStreamJsonArgs(args: string[]): string[] {
  const next = [...args];
  if (!hasFlag(next, '-p') && !hasFlag(next, '--prompt')) next.unshift('-p', '');
  if (!hasFlag(next, '--output-format') && !hasFlag(next, '-o')) next.push('--output-format', 'stream-json');
  return next;
}

// `--approval-mode=yolo` — confirmed against geminicli.com/docs/reference/configuration/ (equivalent
// to the older `--yolo`; both bypass all tool-call confirmation prompts). Google's docs also note
// gemini-cli's own sandbox is auto-enabled alongside yolo mode as an additional safety layer.
function withGeminiSkipApprovalArgs(args: string[], skipProviderApprovals: boolean): string[] {
  if (!skipProviderApprovals || hasFlag(args, '--approval-mode') || hasFlag(args, '--yolo')) return args;
  return [...args, '--approval-mode=yolo'];
}

function geminiExtraWorkingPathArgs(paths: string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => ['--include-directories', path]);
}

function buildGeminiLaunch(agent: MeshAgentView, opts: LegacyProviderLaunchOptions): LegacyProviderLaunchSpec {
  const launchMode = opts.launchMode ?? 'json-stream';
  let args = [...(agent.args ?? [])];
  if (opts.providerSessionRef && !hasFlag(args, '--resume') && !hasFlag(args, '-r')) {
    args.push('--resume', opts.providerSessionRef);
  }
  const modelId = opts.modelId ?? opts.modelName;
  if (modelId && !hasFlag(args, '--model') && !hasFlag(args, '-m')) {
    args.push('--model', modelId);
  }
  args = withGeminiSkipApprovalArgs(args, !!opts.skipProviderApprovals);
  args = [...args, ...geminiExtraWorkingPathArgs(opts.extraWorkingPaths)];
  const launchArgs = launchMode === 'json-stream' ? withGeminiStreamJsonArgs(args) : args;
  return {
    argv: [agent.command, ...launchArgs],
    cwd: opts.workingPath,
    env: agent.env,
    launchMode,
    provider: 'gemini',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'json-stream', 'provider-approval', 'structured-output', 'session-resume']
  };
}

function createGeminiSessionRuntime(
  agent: MeshAgentView,
  context: MeshAgentSessionRuntimeContext
): SessionEventRuntimeDefinition {
  const turnText = (input: { text: string; attachments: readonly { name: string; path: string }[] }): string => {
    if (input.attachments.length === 0) return input.text;
    const refs = input.attachments.map((attachment) => `- ${attachment.name}: ${attachment.path}`).join('\n');
    return `${input.text}\n\nAttachments available in the workspace:\n${refs}`;
  };
  return {
    plan: {
      processModel: 'per-turn',
      buildTurnLaunch: ({ providerSessionRef }) => {
        const launch = buildGeminiLaunch(agent, {
          workingPath: context.workingPath,
          extraWorkingPaths: context.extraWorkingPaths,
          launchMode: 'json-stream',
          providerSessionRef,
          skipProviderApprovals: context.skipProviderApprovals,
          modelName: context.modelName,
          modelId: context.modelId
        });
        return {
          args: launch.argv.slice(1),
          cwd: launch.cwd,
          ...(context.env || launch.env ? { env: { ...(launch.env ?? {}), ...(context.env ?? {}) } } : {})
        };
      },
      encodeTurnInput: (input) => ({
        delivery: 'stdin',
        bytes: new TextEncoder().encode(turnText(input))
      }),
      startup: { timeoutMs: 20_000 },
      continuation: { strategy: 'provider-session-ref' }
    },
    driver: new SessionEventJsonlDriver({ parseOutput: createGeminiStreamJsonParser() })
  };
}

function buildGeminiAuthLaunch(agent: MeshAgentView, args: string[]): LegacyProviderLaunchSpec {
  return {
    argv: [agent.command, ...args],
    cwd: homedir(),
    env: {
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...agent.env,
      NO_BROWSER: 'true'
    },
    launchMode: 'pty',
    provider: 'gemini',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'provider-approval']
  };
}

function buildGeminiAuthStatusLaunch(agent: MeshAgentView): LegacyProviderLaunchSpec {
  void agent;
  const script = String.raw`
const { existsSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

const home = homedir();
const settings = readJson(join(home, '.gemini', 'settings.json'));
const accounts = readJson(join(home, '.gemini', 'google_accounts.json'));
const selectedType = settings?.security?.auth?.selectedType;
const hasApiKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const hasActiveGoogleAccount = typeof accounts?.active === 'string' && accounts.active.length > 0;
const hasAdc =
  (process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) ||
  existsSync(join(home, '.config', 'gcloud', 'application_default_credentials.json'));

let state = 'unknown';
if (hasApiKey || hasActiveGoogleAccount || hasAdc) state = 'authenticated';
else if (selectedType === 'oauth-personal' || selectedType === 'gemini-api-key' || selectedType === 'vertex-ai') {
  state = 'unauthenticated';
}

process.stdout.write(JSON.stringify({ state }) + '\n');
`;
  return {
    argv: [process.execPath, '--eval', script],
    cwd: homedir(),
    env: agent.env,
    launchMode: 'pty',
    provider: 'gemini',
    approvalOwnership: 'provider-owned',
    capabilities: ['pty', 'provider-approval']
  };
}

function geminiCheckpointText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) return '';
      const item = part as Record<string, unknown>;
      return typeof item.text === 'string' ? item.text : '';
    })
    .join('');
}

function geminiCheckpointOutput(context: MeshAgentProviderEventContext, raw: string): string | null {
  const records: Record<string, unknown>[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    const record = parseJsonObject(line);
    if (!record) continue;
    if (record.sessionId === context.providerSessionRef) {
      records.push({ type: 'init', session_id: record.sessionId });
      continue;
    }
    const set = record.$set;
    if (!set || typeof set !== 'object' || Array.isArray(set)) continue;
    const messages = (set as Record<string, unknown>).messages;
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
      const item = message as Record<string, unknown>;
      if (item.type !== 'model' && item.type !== 'assistant') continue;
      const text = geminiCheckpointText(item.content);
      if (text) records.push({ type: 'message', role: 'assistant', content: text });
    }
  }
  return records.length > 0 ? records.map((record) => JSON.stringify(record)).join('\n') : null;
}

function readGeminiHistoryOutput(context: MeshAgentProviderEventContext): string | null {
  const raw = readProviderEventFile({
    roots: [join(homedir(), '.gemini', 'tmp'), join(homedir(), '.gemini', 'history')],
    providerSessionRef: context.providerSessionRef,
    extensions: ['.jsonl', '.json'],
    maxDepth: 8
  });
  if (!raw) return null;
  if (hasGeminiStreamJsonEvents(raw)) return raw;
  return geminiCheckpointOutput(context, raw);
}

export const geminiMeshAgentAdapter: MeshAgentProviderAdapter = {
  provider: 'gemini',
  productIcon: 'gemini',
  label: 'Gemini CLI',
  observation: geminiObservationProjection,
  events: createOutputEventSource({
    provider: 'gemini',
    projection: geminiObservationProjection,
    readOutput: readGeminiHistoryOutput
  }),
  settings: () => meshAgentAdapterSettings(),
  settingsImport: createBasicSettingsImport('gemini', 'Gemini CLI', 'gemini', '.gemini'),
  unsafeArgument: (args) =>
    args.find(
      (arg, index) =>
        arg === '--yolo' || arg === '--approval-mode=yolo' || (arg === '--approval-mode' && args[index + 1] === 'yolo')
    ),
  managedRuntime: {
    env: ({ workspace }) => geminiManagedEnv(workspace)
  },
  detect(probes = defaultBinProbes) {
    const geminiBin = resolveBinary('gemini', [], probes);
    const installed = geminiBin !== undefined;
    return {
      id: 'gemini',
      label: geminiMeshAgentAdapter.label,
      provider: 'gemini',
      productIcon: geminiMeshAgentAdapter.productIcon,
      command: 'gemini',
      args: [],
      modelOptions: geminiMeshAgentAdapter.listSupportedModels(),
      installHint: 'Install Gemini CLI, then complete its provider-owned authentication flow.',
      installUrl: 'https://github.com/google-gemini/gemini-cli',
      installed,
      resolvedBinPath: geminiBin,
      capabilities: {
        auth: 'pty',
        events: 'provider-owned',
        resume: 'pty',
        approval: 'provider-owned',
        settingsImport: true
      }
    };
  },
  resolveCommand(command, probes = defaultBinProbes) {
    return resolveBinary(command, [], probes);
  },
  listSupportedModels(agent) {
    return agent?.modelOptions?.length ? agent.modelOptions : GEMINI_SUPPORTED_MODELS;
  },
  archiveSession: archiveGeminiSession,
  deleteSession: deleteGeminiSession,
  createSessionRuntime: createGeminiSessionRuntime,
  buildAuthLaunch(agent) {
    return buildGeminiAuthLaunch(agent, []);
  },
  buildAuthStatusLaunch(agent) {
    return buildGeminiAuthStatusLaunch(agent);
  },
  authStatus(agent) {
    return {
      launch: buildGeminiAuthStatusLaunch(agent),
      parse: (output, exitCode) => geminiMeshAgentAdapter.parseAuthStatus(output, exitCode)
    };
  },
  argumentSupport(agent) {
    return {
      launch: buildGeminiAuthLaunch(agent, ['--help']),
      parse: (output) => parseMeshAgentArgumentSupport(output)
    };
  },
  parseAuthStatus(output, exitCode) {
    const structured = parseStructuredAuthState(output);
    if (structured) return structured;
    void exitCode;
    return 'unknown';
  }
};
