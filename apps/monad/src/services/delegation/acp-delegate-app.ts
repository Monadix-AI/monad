import type { RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { LiveDelegate, Term } from './acp-delegate-types.ts';

import { client as createAcpClient } from '@agentclientprotocol/sdk';

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

/** Build the ACP client app for a delegate. Created once; every handler reads the CURRENT turn (and the
 *  delegate's connection-lifetime terminals), so the same connection can serve successive prompts. */
export function buildDelegateApp(d: LiveDelegate) {
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
