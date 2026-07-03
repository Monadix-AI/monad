// monad as an ACP CLIENT: the `agent_acp_delegate` tool spawns a configured external ACP agent
// (claude-code-acp / codex acp / …) and drives it over stdio to carry out a self-contained subtask,
// returning its final answer. This is the mirror of the agent side (transports/acp/connection.ts):
// here monad holds the ACP client connection. Lives in apps/monad because it needs the ACP SDK.
//
// Trust + containment: only operator-vetted entries in cfg.acpAgents can be spawned (the model
// supplies a NAME, never a command — that would be RCE), and the tool is high-risk so spawning is
// gated by oversight. monad serves the sub-agent's FILESYSTEM and TERMINAL (advertised fs+terminal
// capabilities) through its OWN backends — the session's delegating backend if present (so a bridged
// editor session delegating onward routes the sub-agent's files/shell to the editor too), else a
// sandbox over the session roots — so the sub-agent's reads/writes/commands stay inside monad's
// boundary. The sub-agent's permission prompts route through monad's oversight gate, and its tool
// calls surface on the parent turn's stream via reportProgress.
//
// Multi-turn reuse: a delegation does NOT spawn-prompt-kill in one shot. The spawned adapter and its
// established ACP session are kept alive per (parent session, agent) so a follow-up delegation to the
// same agent CONTINUES the sub-agent's conversation (its context, its open files) instead of paying a
// fresh spawn + ACP handshake every turn. The persistent ClientConnection (app.connect) is held on
// the delegate; the builder handlers read a SWAPPABLE per-turn slot so one connection serves
// successive prompts. Lifecycle: evicted on the parent session's delete/reset
// (clearAcpDelegatesForSession), on adapter exit, on turn abort/failure, and after an idle timeout.

import type { ClientConnection, McpServer, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AcpAgentConfig, McpServerConfig, MonadAuth } from '@monad/home';
import type { LocalePack, Translate } from '@monad/i18n';
import type { SessionMcpServer } from '@monad/protocol';
import type { TerminalExecResult, Tool, ToolBackends, ToolContext, ToolGate } from '@/capabilities/tools/types.ts';
import type { Store } from '@/store/db/index.ts';

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { client as createAcpClient, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { createI18n } from '@monad/i18n';
import { enMessages, zhMessages } from '@monad/i18n/messages';
import { createLogger } from '@monad/logger';
import { z } from 'zod';

import { mcpHttpHeaders } from '@/bootstrap/mcp.ts';
import { buildSandboxPolicy, createSandboxBackends, sandboxedSpawn, sandboxLauncher } from '@/capabilities/tools';
import { toolResult } from '@/capabilities/tools/types.ts';
import { resolveSecretMap, tryResolveSecretMap } from '@/config/secrets.ts';

// Env markers a delegated sub-agent must NOT inherit. Claude Code refuses to start if it sees its own
// CLAUDECODE nested-session guard — which leaks down whenever monad was itself launched from a Claude
// Code session — so the adapter would abort with "cannot be launched inside another Claude Code
// session". Stripped for every adapter (harmless for those that ignore them). Centralized here so the
// set is visible/greppable rather than buried at the spawn site.
const STRIPPED_CHILD_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'] as const;
const ACP_GUIDANCE_LOCALE_PACKS: LocalePack[] = [
  { locale: 'en', name: 'English', messages: enMessages },
  { locale: 'zh', name: '简体中文', messages: zhMessages }
];
const defaultAcpGuidanceT = createI18n({ locale: 'en', packs: ACP_GUIDANCE_LOCALE_PACKS }).t;

// Non-interactive spawns (Bun.spawn) don't source the login shell, so version-manager
// shims (nvm/fnm/volta) that only put node/npx on an INTERACTIVE PATH are absent — an
// adapter launched as `npx -y …` then dies with ENOENT ("npx not on PATH"). Prepend
// the real node bin dirs we can find so adapters resolve regardless of how the daemon
// was started. Best-effort + existence-filtered; a no-op when node is already on PATH.
function nodeBinDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  try {
    // newest version first (e.g. v26 before v24); numeric sort so v10 > v9.
    for (const v of readdirSync(nvmRoot).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
      dirs.push(join(nvmRoot, v, 'bin'));
  } catch {
    // no nvm install — fine
  }
  dirs.push(
    '/opt/homebrew/bin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'Library', 'pnpm')
  );
  return dirs.filter((d) => existsSync(d));
}

// Backstop for the ACP handshake (initialize + newSession). A missing/crashing/non-ACP adapter leaves
// initialize() awaiting a reply that never arrives, which would hang the parent turn forever; this cap
// turns that into a clear error. It guards ONLY the handshake — the prompt that follows may legitimately
// run long and is bounded instead by the caller's abort signal.
const HANDSHAKE_TIMEOUT_MS = 60_000;

// Evict a reused delegate after this much idle time so an abandoned conversation doesn't keep a
// third-party adapter (and any MCP child processes it spawned) resident forever.
const DELEGATE_IDLE_MS = 5 * 60_000;

// Env keys that could hijack a spawned command's runtime regardless of value: loader injection
// (LD_PRELOAD / DYLD_INSERT_LIBRARIES), PATH substitution, language require-at-start flags, and shell
// startup-file vectors (BASH_ENV / ENV / ZDOTDIR). The sub-agent is third-party code and its ACP
// message content is not trusted at the OS privilege level, so strip these from any env it supplies to
// backends.terminal.exec. Matched case-insensitively (names normalised to uppercase) to block bypasses.
const ENV_INJECT_DENYLIST = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FORCE_FLAT_NAMESPACE',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'RUBYLIB',
  'RUBYOPT',
  'PERL5LIB',
  'PERL5OPT',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR'
]);

/** Quote an ACP command+args (a program + argv) into one shell string for monad's terminal backend. */
function shellQuote(parts: string[]): string {
  return parts.map((p) => `'${p.replaceAll("'", "'\\''")}'`).join(' ');
}

const log = createLogger('acp-delegate');

const toPairs = (m: Record<string, string>): { name: string; value: string }[] =>
  Object.entries(m).map(([name, value]) => ({ name, value }));

/**
 * Map monad's configured MCP servers into the ACP `newSession` shape so a delegated sub-agent shares
 * monad's external tools. PER-SERVER ISOLATED: a server whose secret refs (${env:}/${secret:}) fail to
 * resolve, or an oauth-mode http server (its bearer is refreshed dynamically and can't be forwarded as
 * a static header), is SKIPPED and logged — one bad server never aborts the whole set (mirrors how
 * bootstrap/mcp.ts isolates each server). Reuses bootstrap's mcpHttpHeaders so http auth stays in sync.
 *
 * Caveats by design: forwarding hands RESOLVED secrets to third-party adapter code and makes the
 * adapter spawn its OWN second copy of each stdio server (a stateful server — single write-lock DB,
 * exclusive port, singleton browser — may conflict with monad's instance). That's why it's gated per
 * agent by `forwardMcp` (default off). http servers are additionally filtered at delegation time to
 * adapters that advertise mcp http capability (see spawnDelegate). Browser/computer PRESET MCP
 * servers are intentionally NOT forwarded — they grant host control and are not "shared tools".
 * Exported for testing.
 */
export function toAcpMcpServers(servers: McpServerConfig[], auth?: MonadAuth): McpServer[] {
  const out: McpServer[] = [];
  for (const s of servers) {
    if (!s.enabled) continue;
    if (s.transport === 'http' && s.auth.mode === 'oauth') {
      log.debug({ server: s.name }, 'not forwarding oauth MCP server (dynamic bearer not forwardable)');
      continue;
    }
    try {
      if (s.transport === 'stdio') {
        out.push({
          name: s.name,
          command: s.command,
          args: s.args ?? [],
          env: toPairs(resolveSecretMap(s.env, auth) ?? {})
        });
      } else {
        out.push({ name: s.name, type: 'http', url: s.url, headers: toPairs(mcpHttpHeaders(s, auth)) });
      }
    } catch (err) {
      log.warn({ server: s.name, err: String(err) }, 'not forwarding MCP server (unresolved secret)');
    }
  }
  return out;
}

export function sessionMcpServersToAcp(servers: SessionMcpServer[]): McpServer[] {
  return servers.map((s) => {
    if (s.transport === 'http') {
      return {
        name: s.name,
        type: 'http',
        url: s.url,
        headers: toPairs(s.headers ?? {})
      };
    }
    return {
      name: s.name,
      command: s.command,
      args: s.args ?? [],
      env: toPairs(s.env ?? {})
    };
  });
}

export interface AcpDelegateDeps {
  agents: AcpAgentConfig[];
  /** Oversight gate — the sub-agent's permission requests route through it. Absent → auto-allow. */
  gate?: ToolGate;
  /** monad's configured MCP servers (ACP shape) to forward so the sub-agent shares monad's tools. */
  mcpServers?: McpServer[];
  /** Persistence store — when provided, delegate lifecycle is recorded in acp_delegates. */
  store?: Store;
}

const delegateInput = z.object({
  agent: z.string().min(1).describe('Name of a configured external ACP agent to delegate to'),
  instruction: z.string().min(1).describe('A self-contained instruction for the sub-agent to carry out')
});
type DelegateInput = z.infer<typeof delegateInput>;

/**
 * Build the adapter's spawn env + the extra writable roots it needs. Two concerns, both exported for
 * testing:
 *  1. Strip STRIPPED_CHILD_ENV so a nested Claude Code adapter starts as a clean top-level session.
 *  2. Make `osSandbox` usable: when the adapter PROCESS is OS-jailed, sandboxedSpawn redirects HOME to
 *     the disposable sandbox root, hiding the user's real login state (~/.codex, ~/.claude) and breaking
 *     auth. Pin the adapters' config dirs back to the REAL home (these keys survive the HOME overlay
 *     since they aren't in it) AND return those dirs as writable roots so the adapter can also write its
 *     session/history there. `??=` so an explicit operator-set value wins. No-op when osSandbox is off
 *     (HOME isn't redirected, so the adapter finds its real credentials anyway).
 */
export function adapterSpawnEnv(
  spec: AcpAgentConfig,
  base: Record<string, string | undefined>
): { env: Record<string, string | undefined>; credentialDirs: string[] } {
  const env = { ...base };
  for (const key of STRIPPED_CHILD_ENV) delete env[key];
  // Make `npx`/`node` resolvable for adapters even when the daemon was launched without
  // the version-manager's interactive PATH (the common cause of "npx not on PATH").
  const extraPath = nodeBinDirs();
  if (extraPath.length) {
    const seen = new Set<string>();
    env.PATH = [...extraPath, ...(env.PATH ?? '').split(':')]
      .filter((d) => {
        if (!d || seen.has(d)) return false;
        seen.add(d);
        return true;
      })
      .join(':');
  }
  const credentialDirs: string[] = [];
  if (spec.osSandbox === true) {
    const codexHome = join(homedir(), '.codex');
    const claudeDir = join(homedir(), '.claude');
    env.CODEX_HOME ??= codexHome;
    env.CLAUDE_CONFIG_DIR ??= claudeDir;
    credentialDirs.push(codexHome, claudeDir);
  }
  return { env, credentialDirs };
}

// ── Reusable live delegates ──────────────────────────────────────────────────────────────────────
// The builder handlers below are registered ONCE per delegate but must serve whichever turn is
// currently running, so the per-turn state — the caller's ctx/gate/backends plus the result/activity
// accumulators — lives in a swappable `turn` slot rather than being captured as call-locals.

// ACP terminals are handle-based (create → poll output / wait exit / kill / release); monad's terminal
// backend is a single exec. Bridge by running exec in the background and tracking state.
interface Term {
  output: string;
  result: TerminalExecResult | null;
  done: Promise<TerminalExecResult | null>;
  abort: AbortController;
}

// Per-turn state the long-lived builder handlers read. `result` = the sub-agent's answer (returned to
// the model); `activity` = a live log that ALSO surfaces the sub-agent's tool calls, reported via
// ctx.reportProgress so the user sees what the delegated agent is doing on the parent turn's stream.
interface DelegateTurn {
  ctx: ToolContext;
  gate: ToolGate | undefined;
  backends: ToolBackends;
  result: string;
  activity: string;
  processActivity: string;
  onChunk?: (delta: string) => void;
  onActivity?: (activity: string) => void;
}

interface LiveDelegate {
  spec: AcpAgentConfig;
  proc: ReturnType<typeof sandboxedSpawn>;
  conn: ClientConnection;
  acpSessionId: string;
  terminals: Map<string, Term>;
  termSeq: number;
  turn: DelegateTurn | null; // set for the duration of a prompt; null between turns
  idleTimer: ReturnType<typeof setTimeout> | null;
  queue: Promise<unknown>; // serializes prompts to this delegate (parallel tool calls share one session)
  // Counters kept in sync with the persisted row so touchAcpDelegate can write the current values.
  reuseCount: number; // incremented on each successful getOrSpawn that found an existing delegate
  promptCount: number; // incremented after each successful session/prompt
}

// NUL separator (created at runtime — never a literal NUL byte in source) so neither the session id
// nor the agent name can forge the key boundary.
const KEY_SEP = String.fromCharCode(0);
// One reusable delegate per (parent session, agent name). Module-level so it survives the tool being
// re-created on config hot-reload.
const liveDelegates = new Map<string, LiveDelegate>();
// In-flight spawns, so two concurrent delegations to the same key share one adapter instead of racing
// to spawn two (one of which would leak).
const pendingSpawns = new Map<string, Promise<LiveDelegate>>();

// Module-level store reference — set from createAcpDelegateTool so evictDelegate (which receives no
// deps) can call store methods. Hot-reload safe: re-registration replaces this with the same instance.
let delegateStore: Store | undefined;

const delegateKey = (sessionId: string, agent: string): string => `${sessionId}${KEY_SEP}${agent}`;
const isAlive = (d: LiveDelegate): boolean => d.proc.exitCode === null && d.proc.signalCode === null;

// Thrown when a QUEUED prompt finds its delegate was evicted out from under it (a concurrent delegation
// to the same agent aborted, or the adapter exited) before the prompt got to run — runExternalAgent
// catches this specific signal and re-spawns a fresh delegate rather than driving a dead connection.
class DelegateEvictedError extends Error {}

// Common auth-failure fingerprints in adapter error messages — the sub-agent started fine (ACP handshake
// completed) but its internal API call was rejected with 401 or equivalent.
const AUTH_ERROR_PATTERNS = [
  /401/i,
  /403/i,
  /authentication/i,
  /unauthorized/i,
  /invalid.*(?:api|auth).*(?:key|credential|token)/i,
  /not logged in/i,
  /Failed to authenticate/i
];

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return AUTH_ERROR_PATTERNS.some((p) => p.test(msg));
}

/** Return a user-facing hint for fixing an ACP agent error, or null if no specific guidance applies. */
export function acpAuthGuidance(err: unknown, spec: AcpAgentConfig, translate?: Translate): string | null {
  if (!isAuthError(err)) return null;
  const t = translate ?? defaultAcpGuidanceT;
  const name = spec.name;
  const isClaude = name === 'claude-code' || /\bclaude\b/i.test(spec.command);
  const isCodex = name === 'codex' || /\bcodex\b/i.test(spec.command);
  const lines: string[] = [];
  const envRefExample = (key: string) => t('web.acp.authGuidance.envRef', { key, ref: `\${env:${key}}` });
  if (isClaude) {
    lines.push(t('web.acp.authGuidance.claudeIntro'));
    lines.push(envRefExample('ANTHROPIC_API_KEY'));
    lines.push(t('web.acp.authGuidance.claudeLogin'));
  } else if (isCodex) {
    lines.push(t('web.acp.authGuidance.codexIntro'));
    lines.push(envRefExample('OPENAI_API_KEY'));
    lines.push(t('web.acp.authGuidance.codexLogin'));
  } else {
    lines.push(t('web.acp.authGuidance.generic'));
  }
  return lines.join('\n');
}

// The actionable "couldn't drive the adapter" error, shared by the spawn + prompt failure paths.
function adapterFailureError(name: string, exitCode: number | null, cause: unknown): Error {
  const exited = exitCode != null ? ` (adapter exited with code ${exitCode})` : '';
  const why = cause instanceof Error ? cause.message : String(cause);
  const suffix = isAuthError(cause)
    ? '— API credentials were rejected (the adapter is installed but authentication failed)'
    : '— ensure the adapter is installed and you are logged in';
  return new Error(`failed to run external agent "${name}"${exited}: ${why} ${suffix}`);
}

// Reap every resident adapter when the daemon exits, mirroring the spawned-process registry
// (tools/process.ts). The reuse model keeps adapters — and any MCP servers they spawned — alive between
// turns, so without this a daemon stop/crash would orphan them. Sync handler: proc.kill() is the reap.
process.on('exit', () => {
  for (const d of liveDelegates.values()) d.proc.kill();
});

// Tear a delegate down: drop it from the registry, cancel its idle timer, abort lingering terminals,
// close the connection, kill the adapter. Idempotent.
function evictDelegate(key: string, reason: string): void {
  const d = liveDelegates.get(key);
  if (!d) return;
  liveDelegates.delete(key);
  if (d.idleTimer) clearTimeout(d.idleTimer);
  for (const t of d.terminals.values()) t.abort.abort();
  d.terminals.clear();
  try {
    d.conn.close();
  } catch {
    // already closed — fine
  }
  d.proc.kill();
  try {
    delegateStore?.closeAcpDelegate(key, new Date().toISOString(), reason);
  } catch (err) {
    log.warn({ key, reason, err }, 'failed to persist delegate eviction');
  }
  log.debug({ agent: d.spec.name, reason }, 'external ACP delegate evicted');
}

/** Kill + drop every live delegate spawned under a parent session — call on session delete/reset so a
 *  reused adapter never outlives the conversation that owns it. */
export function clearAcpDelegatesForSession(sessionId: string): void {
  const prefix = `${sessionId}${KEY_SEP}`;
  for (const key of liveDelegates.keys()) {
    if (key.startsWith(prefix)) evictDelegate(key, 'session ended');
  }
}

/** Build the ACP client app for a delegate. Created once; every handler reads the CURRENT turn (and the
 *  delegate's connection-lifetime terminals), so the same connection can serve successive prompts. */
function buildDelegateApp(d: LiveDelegate) {
  return (
    createAcpClient()
      .onNotification('session/update', ({ params: p }) => {
        const turn = d.turn;
        if (!turn) return; // a stray update arriving between turns — nothing to attribute it to
        const u = p.update;
        let activityChanged = false;
        let processActivityChanged = false;
        switch (u.sessionUpdate) {
          case 'agent_message_chunk':
            if (u.content.type === 'text') {
              turn.result += u.content.text;
              turn.activity += u.content.text;
              turn.onChunk?.(u.content.text);
              activityChanged = true;
            }
            break;
          case 'tool_call':
            turn.activity += `\n  ↪ ${u.title || u.toolCallId}`;
            turn.processActivity += `\n  ↪ ${u.title || u.toolCallId}`;
            activityChanged = true;
            processActivityChanged = true;
            break;
          case 'tool_call_update':
            if (u.status === 'completed' || u.status === 'failed') {
              turn.activity += ` [${u.status}]`;
              turn.processActivity += ` [${u.status}]`;
              activityChanged = true;
              processActivityChanged = true;
            }
            break;
          case 'plan':
            // the sub-agent's checklist — high-signal for the user watching the delegation.
            turn.activity += `\n  ▤ plan:${u.entries.map((e) => `\n     - [${e.status}] ${e.content}`).join('')}`;
            turn.processActivity += `\n  ▤ plan:${u.entries.map((e) => `\n     - [${e.status}] ${e.content}`).join('')}`;
            activityChanged = true;
            processActivityChanged = true;
            break;
        }
        if (activityChanged) turn.ctx.reportProgress?.(turn.activity);
        if (processActivityChanged) turn.onActivity?.(turn.processActivity.trimStart());
      })
      // The sub-agent's self-declared high-risk ops surface on monad's oversight stream (same gate as
      // monad's own tools). No gate configured → allow (the high-risk delegate tool was already gated).
      .onRequest('session/request_permission', async ({ params: req }): Promise<RequestPermissionResponse> => {
        const pick = (kinds: string[]): string | undefined => req.options.find((o) => kinds.includes(o.kind))?.optionId;
        const turn = d.turn;
        if (turn?.gate) {
          const outcome = await turn.gate({
            tool: `acp:${d.spec.name}:${req.toolCall.title}`,
            sessionId: turn.ctx.sessionId,
            highRisk: true,
            input: req.toolCall.rawInput
          });
          if (!outcome.allow) {
            const reject = pick(['reject_once', 'reject_always']);
            return reject
              ? { outcome: { outcome: 'selected', optionId: reject } }
              : { outcome: { outcome: 'cancelled' } };
          }
        }
        // monad acting as an ACP *client*, auto-answering a delegated agent's own permission prompt — NOT
        // the local approval gate. No persistence/scope model here, so collapsing allow_always to a plain
        // selection is correct (the tiered allowlist lives in OversightService).
        const allow = pick(['allow_once', 'allow_always']) ?? req.options[0]?.optionId ?? 'allow';
        return { outcome: { outcome: 'selected', optionId: allow } };
      })
      .onRequest('fs/read_text_file', async ({ params }) => {
        const backends = d.turn?.backends;
        if (!backends) throw new Error('no active delegation turn');
        const content = await backends.fs.readTextFile(params.path, {
          offset: params.line ?? undefined,
          limit: params.limit ?? undefined
        });
        return { content };
      })
      .onRequest('fs/write_text_file', async ({ params }) => {
        const backends = d.turn?.backends;
        if (!backends) throw new Error('no active delegation turn');
        await backends.fs.writeTextFile(params.path, params.content);
        return {};
      })
      .onRequest('terminal/create', async ({ params }) => {
        const backends = d.turn?.backends;
        if (!backends) throw new Error('no active delegation turn');
        const terminalId = `term_${++d.termSeq}`;
        const abort = new AbortController();
        const command = shellQuote([params.command, ...(params.args ?? [])]);
        // Strip injection vectors (see ENV_INJECT_DENYLIST) before handing the sub-agent's env to monad's
        // terminal backend, which runs the command under monad's OS privileges. Case-insensitive.
        const termEnv = params.env?.length
          ? Object.fromEntries(
              params.env.filter((v) => !ENV_INJECT_DENYLIST.has(v.name.toUpperCase())).map((v) => [v.name, v.value])
            )
          : undefined;
        const term: Term = { output: '', result: null, abort, done: Promise.resolve(null) };
        term.done = backends.terminal
          .exec({
            command,
            cwd: params.cwd ?? undefined,
            env: termEnv,
            signal: abort.signal,
            onChunk: (o) => (term.output = o)
          })
          .then((r) => {
            term.result = r;
            return r;
          })
          .catch(() => null);
        d.terminals.set(terminalId, term);
        return { terminalId };
      })
      .onRequest('terminal/output', ({ params }) => {
        const term = d.terminals.get(params.terminalId);
        if (!term) return { output: '', truncated: false };
        return {
          output: term.output,
          truncated: false,
          exitStatus: term.result ? { exitCode: term.result.exitCode, signal: null } : null
        };
      })
      .onRequest('terminal/wait_for_exit', async ({ params }) => {
        const r = await d.terminals.get(params.terminalId)?.done;
        return { exitCode: r?.exitCode ?? null, signal: null };
      })
      .onRequest('terminal/kill', ({ params }) => {
        d.terminals.get(params.terminalId)?.abort.abort();
        return {};
      })
      .onRequest('terminal/release', ({ params }) => {
        d.terminals.get(params.terminalId)?.abort.abort();
        d.terminals.delete(params.terminalId);
        return {};
      })
  );
}

/** Spawn an external ACP adapter and complete the handshake (initialize + newSession), returning a live
 *  delegate ready to be prompted. Does NOT run a prompt. Throws (registering nothing) on spawn or
 *  handshake failure. */
async function spawnDelegate(
  key: string,
  spec: AcpAgentConfig,
  ctx: ToolContext,
  mcpServers: McpServer[]
): Promise<LiveDelegate> {
  // The delegated sub-agent is a NEW top-level session, not a continuation of whatever launched monad —
  // strip the session markers it must not inherit (see STRIPPED_CHILD_ENV) from the env.
  // Best-effort: silently skip unresolvable secret refs (e.g. ${env:ANTHROPIC_API_KEY} when unset)
  // so the adapter can fall back to its own credential discovery (~/.claude, ~/.codex, etc.).
  const { env, credentialDirs } = adapterSpawnEnv(spec, { ...Bun.env, ...tryResolveSecretMap(spec.env) });

  // Opt-in double containment beyond ACP's capability-level interception: when osSandbox is set, the
  // adapter PROCESS is also OS-jailed to the session roots. Warn when requested but no launcher is
  // armed, since sandboxedSpawn then passes through (see adapterSpawnEnv + the daemon-wide config note).
  if (spec.osSandbox === true && sandboxLauncher().kind === 'none') {
    log.warn(
      { agent: spec.name },
      'osSandbox requested but no OS sandbox launcher is armed (agent.sandbox.confine is off) — the adapter runs unconfined'
    );
  }
  // Bun.spawn throws synchronously when the program isn't found (e.g. `npx` not on PATH) — turn that
  // into an actionable message instead of a bare ENOENT bubbling up to the model.
  const proc = (() => {
    try {
      return sandboxedSpawn(
        [spec.command, ...(spec.args ?? [])],
        {
          cwd: spec.cwd ?? ctx.sandboxRoots?.[0],
          env,
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'inherit' // the sub-agent's logs pass through to the daemon's stderr
        },
        buildSandboxPolicy(ctx.sandboxRoots, credentialDirs),
        { confine: spec.osSandbox === true }
      );
    } catch (err) {
      throw new Error(
        `could not start external agent "${spec.name}" (command "${spec.command}"): ${err instanceof Error ? err.message : String(err)} — is it installed and on PATH?`
      );
    }
  })();

  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      proc.stdin.write(chunk);
      proc.stdin.flush();
    },
    close() {
      proc.stdin.end();
    }
  });

  const d: LiveDelegate = {
    spec,
    proc,
    conn: undefined as unknown as ClientConnection, // set on the next line (handlers need `d`)
    acpSessionId: '',
    terminals: new Map(),
    termSeq: 0,
    turn: null,
    idleTimer: null,
    queue: Promise.resolve(),
    reuseCount: 0,
    promptCount: 0
  };
  d.conn = buildDelegateApp(d).connect(ndJsonStream(output, proc.stdout));

  // If the adapter dies on its own (crash, OOM, killed externally), tear the delegate down FULLY (abort
  // its terminals, close the conn, drop it) so the next delegation re-spawns instead of reusing a dead
  // connection. Identity-guarded so a re-spawn that already replaced this proc under the same key is left
  // untouched; evictDelegate's proc.kill() is a harmless no-op on the already-dead proc.
  void proc.exited.then((code) => {
    if (liveDelegates.get(key)?.proc === proc) evictDelegate(key, 'adapter exited');
    log.debug({ agent: spec.name, code }, 'external ACP adapter exited');
  });

  // Kill the adapter if the handshake stalls, so a hung initialize/newSession can't wedge the turn.
  let handshakeTimedOut = false;
  const handshakeTimer = setTimeout(() => {
    handshakeTimedOut = true;
    proc.kill();
  }, HANDSHAKE_TIMEOUT_MS);
  try {
    // Advertise fs + terminal so the sub-agent routes file ops AND shell through monad (served above).
    const init = await d.conn.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
    });
    // Only forward http MCP servers to adapters that advertise http MCP support (stdio is baseline); a
    // stdio-only adapter (e.g. codex-acp) would otherwise reject newSession or silently drop them.
    const httpOk = init.agentCapabilities?.mcpCapabilities?.http === true;
    const forwarded = httpOk ? mcpServers : mcpServers.filter((s) => !('type' in s && s.type === 'http'));
    if (forwarded.length !== mcpServers.length) {
      log.debug({ agent: spec.name }, 'adapter lacks http MCP capability — forwarding stdio MCP servers only');
    }
    const { sessionId } = await d.conn.agent.request('session/new', {
      cwd: spec.cwd ?? ctx.sandboxRoots?.[0] ?? process.cwd(),
      // Forward monad's configured MCP servers so the sub-agent shares the same external tools.
      mcpServers: forwarded
    });
    d.acpSessionId = sessionId;
    const now = new Date().toISOString();
    try {
      delegateStore?.upsertAcpDelegate({
        id: key,
        sessionId: ctx.sessionId,
        agentName: spec.name,
        acpSessionId: sessionId,
        pid: proc.pid ?? 0,
        spawnedAt: now,
        lastUsedAt: now
      });
    } catch (err) {
      log.warn({ key, agent: spec.name, err }, 'failed to persist delegate spawn');
    }
    return d;
  } catch (err) {
    try {
      d.conn.close();
    } catch {
      // not yet open
    }
    proc.kill();
    if (handshakeTimedOut) {
      throw new Error(
        `external agent "${spec.name}" did not complete the ACP handshake within ${HANDSHAKE_TIMEOUT_MS / 1000}s — check it is installed and speaks ACP`
      );
    }
    throw adapterFailureError(spec.name, proc.exitCode, err);
  } finally {
    clearTimeout(handshakeTimer);
  }
}

/** Get the live delegate for (session, agent), spawning + handshaking one if absent or dead. Concurrent
 *  callers for the same key share a single in-flight spawn. */
async function getOrSpawnDelegate(
  key: string,
  spec: AcpAgentConfig,
  ctx: ToolContext,
  mcpServers: McpServer[]
): Promise<LiveDelegate> {
  const existing = liveDelegates.get(key);
  if (existing && isAlive(existing)) return existing;
  if (existing) evictDelegate(key, 'stale connection');

  let pending = pendingSpawns.get(key);
  if (!pending) {
    pending = spawnDelegate(key, spec, ctx, mcpServers)
      .then((d) => {
        liveDelegates.set(key, d);
        log.debug({ agent: spec.name, session: ctx.sessionId }, 'spawned reusable ACP delegate');
        return d;
      })
      .finally(() => pendingSpawns.delete(key));
    pendingSpawns.set(key, pending);
  }
  const d = await pending;
  // Count reuses: every getOrSpawn that finds an already-live delegate (i.e. not the first spawn)
  // increments reuseCount so the persisted row tracks how many turns were continued vs fresh spawns.
  if (liveDelegates.get(key) === d && d.promptCount > 0) d.reuseCount++;
  return d;
}

/** Drive one prompt on a live delegate to completion, returning its accumulated answer. Sets the
 *  per-turn slot the builder handlers read; tears the delegate down on abort or failure. */
async function promptDelegate(
  d: LiveDelegate,
  key: string,
  instruction: string,
  ctx: ToolContext,
  gate: ToolGate | undefined,
  onChunk?: (delta: string) => void,
  onActivity?: (activity: string) => void
): Promise<string> {
  // This prompt may have waited in the queue behind earlier ones; a concurrent abort or an adapter exit
  // could have evicted the delegate while it waited. Bail BEFORE touching the connection: surface the
  // abort to the caller, or signal runExternalAgent to re-spawn — never drive a dead connection.
  if (ctx.signal?.aborted) {
    evictDelegate(key, 'aborted before prompt');
    throw new Error(`delegation to "${d.spec.name}" aborted`);
  }
  if (liveDelegates.get(key) !== d || !isAlive(d)) {
    throw new DelegateEvictedError(`delegate for "${d.spec.name}" evicted before its turn ran`);
  }
  if (d.idleTimer) {
    clearTimeout(d.idleTimer);
    d.idleTimer = null;
  }
  // The session's delegating backend if present (so a bridged editor session delegating onward routes
  // the sub-agent's files/shell to the editor too), else a sandbox scoped to the session roots. When
  // the bound agent declares its own working folder (spec.cwd) it leads the roots, so monad-serviced
  // fs/terminal requests from that agent reach it (and use it as the default cwd), not only the parent
  // session's folder — keeping the monad sandbox consistent with the cwd the adapter was spawned in.
  const delegateRoots = d.spec.cwd ? [d.spec.cwd, ...(ctx.sandboxRoots ?? [])] : ctx.sandboxRoots;
  const backends = ctx.backends ?? createSandboxBackends(delegateRoots);
  d.turn = { ctx, gate, backends, result: '', activity: '', processActivity: '', onChunk, onActivity };

  // A turn abort (stop button / session cancel) kills the adapter and evicts the delegate; the next
  // delegation re-spawns. Deliberately simpler than ACP session/cancel, which depends on the adapter
  // honouring it and could leave the prompt awaiting after the parent turn already moved on.
  const onAbort = (): void => evictDelegate(key, 'turn aborted');
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await d.conn.agent.request('session/prompt', {
      sessionId: d.acpSessionId,
      prompt: [{ type: 'text', text: instruction }]
    });
    d.promptCount++;
    return d.turn.result;
  } catch (err) {
    if (ctx.signal?.aborted) {
      // user/session cancelled — kill the adapter and surface the original abort. evictDelegate is
      // idempotent: onAbort may already have run, or may never have (if the signal pre-dated the listener).
      evictDelegate(key, 'turn aborted');
      throw err;
    }
    evictDelegate(key, 'prompt failed'); // the connection may be wedged — don't reuse it
    throw adapterFailureError(d.spec.name, d.proc.exitCode, err);
  } finally {
    ctx.signal?.removeEventListener('abort', onAbort);
    d.turn = null;
    // Drop any terminals the sub-agent left open this turn; arm the idle clock if still registered.
    for (const t of d.terminals.values()) t.abort.abort();
    d.terminals.clear();
    if (liveDelegates.get(key) === d && isAlive(d)) {
      const now = new Date().toISOString();
      try {
        const updated = delegateStore?.touchAcpDelegate(key, now, d.reuseCount, d.promptCount);
        if (updated === false) log.warn({ key }, 'touchAcpDelegate updated 0 rows — row may have been evicted');
      } catch (err) {
        log.warn({ key, err }, 'failed to persist delegate prompt stats');
      }
      const timer = setTimeout(() => evictDelegate(key, 'idle'), DELEGATE_IDLE_MS);
      timer.unref?.(); // an idle delegate must not keep the daemon's event loop alive
      d.idleTimer = timer;
    }
  }
}

/** Delegate one instruction to an external ACP agent, REUSING a live (session, agent) delegate when one
 *  exists so follow-ups continue the sub-agent's conversation. Returns its accumulated final text. */
async function runExternalAgent(
  spec: AcpAgentConfig,
  instruction: string,
  ctx: ToolContext,
  gate: ToolGate | undefined,
  mcpServers: McpServer[],
  onChunk?: (delta: string) => void,
  onActivity?: (activity: string) => void
): Promise<string> {
  const key = delegateKey(ctx.sessionId, spec.name);
  log.debug({ sessionId: ctx.sessionId, event: 'acp.prompt.start', agent: spec.name, instruction }, 'acp prompt start');
  // Two attempts at most: a delegate can be evicted between get-or-spawn and the queued prompt actually
  // running (a concurrent delegation to the same agent aborted, or the adapter exited). On that specific
  // signal, re-spawn a fresh delegate once. Any other failure — or our own abort — surfaces immediately.
  for (let attempt = 0; ; attempt++) {
    const d = await getOrSpawnDelegate(key, spec, ctx, mcpServers);
    // Serialize prompts to the same delegate: parallel tool calls to one agent in one session would
    // otherwise clobber the single per-turn slot. Chain each prompt on the delegate's queue.
    const run = d.queue.then(() =>
      promptDelegate(
        d,
        key,
        instruction,
        ctx,
        gate,
        onChunk
          ? (delta) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.chunk', agent: spec.name, delta },
                'acp prompt chunk'
              );
              onChunk(delta);
            }
          : (delta) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.chunk', agent: spec.name, delta },
                'acp prompt chunk'
              );
            },
        onActivity
          ? (activity) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.activity', agent: spec.name, activity },
                'acp prompt activity'
              );
              onActivity(activity);
            }
          : (activity) => {
              log.debug(
                { sessionId: ctx.sessionId, event: 'acp.prompt.activity', agent: spec.name, activity },
                'acp prompt activity'
              );
            }
      )
    );
    d.queue = run.then(
      () => undefined,
      () => undefined
    );
    try {
      const result = await run;
      log.debug(
        { sessionId: ctx.sessionId, event: 'acp.prompt.result', agent: spec.name, result },
        'acp prompt result'
      );
      return result;
    } catch (err) {
      if (err instanceof DelegateEvictedError && attempt === 0) continue; // re-spawn and retry once
      log.debug(
        {
          sessionId: ctx.sessionId,
          event: 'acp.prompt.error',
          agent: spec.name,
          err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err)
        },
        'acp prompt error'
      );
      throw err;
    }
  }
}

/** Options for a direct user→ACP agent delegation that bypasses the monad LLM layer. */
export interface DirectDelegateOpts {
  sessionId: string;
  signal?: AbortSignal;
  /** Called with each streamed text delta as the sub-agent responds. */
  onChunk?: (delta: string) => void;
  /** Called with cumulative non-answer activity such as plan and tool updates. */
  onActivity?: (activity: string) => void;
  sandboxRoots?: string[];
  backends?: ToolBackends;
  toolFilter?: (toolName: string) => boolean;
  extraTools?: Tool[];
  extraSkills?: ToolContext['extraSkills'];
  mcpServers?: McpServer[];
}

/** Send a message directly to a configured ACP agent, bypassing monad's LLM. Reuses a live session
 *  (same multi-turn reuse as agent_acp_delegate) so repeated direct calls continue the conversation. */
export async function directDelegate(spec: AcpAgentConfig, text: string, opts: DirectDelegateOpts): Promise<string> {
  const ctx: ToolContext = {
    sessionId: opts.sessionId,
    signal: opts.signal,
    sandboxRoots: opts.sandboxRoots,
    backends: opts.backends,
    toolFilter: opts.toolFilter,
    extraTools: opts.extraTools,
    extraSkills: opts.extraSkills,
    log: (level, msg, fields) => log[level]({ ...fields }, msg)
  };
  const mcpServers = spec.forwardMcp === true ? (opts.mcpServers ?? []) : [];
  return runExternalAgent(spec, text, ctx, undefined, mcpServers, opts.onChunk, opts.onActivity);
}

/** Build the `agent_acp_delegate` tool from the configured external ACP agents (enabled only). */
export function createAcpDelegateTool(deps: AcpDelegateDeps): Tool<DelegateInput, { text: string }> {
  delegateStore = deps.store;
  const enabled = deps.agents.filter((a) => a.enabled);
  const names = enabled.map((a) => a.name);
  return {
    name: 'agent_acp_delegate',
    description:
      'Delegate a self-contained subtask to an external ACP agent, returning its final answer. ' +
      `Available agents: ${names.join(', ')}. Use for work better handled by a specialised external agent.`,
    scopes: [{ resource: 'agent:delegate' }],
    // Spawning an external agent is a real escalation → route through the oversight gate once.
    highRisk: true,
    inputSchema: delegateInput,
    run: async ({ agent, instruction }, ctx) => {
      const spec = enabled.find((a) => a.name === agent);
      if (!spec) throw new Error(`unknown ACP agent "${agent}" (configured: ${names.join(', ') || 'none'})`);
      log.info({ agent }, 'delegating to external ACP agent');
      // Per-agent opt-in: only forward monad's MCP servers to agents that asked for them (forwardMcp).
      const mcpServers = spec.forwardMcp === true ? (deps.mcpServers ?? []) : [];
      const text = await runExternalAgent(spec, instruction, ctx, deps.gate, mcpServers);
      return toolResult({ text });
    }
  };
}
