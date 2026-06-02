// HookRunner — the daemon's concrete `Hooks` port. It fans one lifecycle event out to two kinds
// of hooks behind a single value-based contract: in-process typed atom-pack hooks and
// out-of-process command hooks (shell, JSON over stdin/stdout). Mutating events run serially in a
// fixed order so mutations chain (each sees the previous one's rewrite) and the first `deny`
// short-circuits; observe/inject-only events (PARALLEL_HOOK_EVENTS) fan out concurrently.
//
// Hard guarantee: a broken hook (throw, spawn failure, bad JSON, timeout) is logged and skipped —
// `run()` never rejects. The one exception is an opt-in `onError: 'deny'` hook, which fails CLOSED:
// its own failure becomes a deny, so a security guard can't be silently waved through. No configured
// hooks for an event → a zero-cost fast path that spawns nothing.

import type { Logger } from '@monad/logger';
import type {
  CommandHookSetting,
  HookDecision,
  HookEvent,
  HookInput,
  HookMatcherSetting,
  HookOutput,
  Hooks
} from '@monad/protocol';
import type { HookDefinition } from '@monad/sdk-atom';

import { hookOutputSchema, PARALLEL_HOOK_EVENTS } from '@monad/protocol';

import { shellArgv } from '@/capabilities/tools';

// Command-hook + matcher shapes are owned by @monad/protocol (commandHookSettingSchema /
// hookMatcherSettingSchema); derive rather than re-declare. `onError` fail-closed: when `deny`, a
// timeout / spawn failure / crash / non-JSON output blocks the step instead of being skipped.
type CommandHookSpec = CommandHookSetting;
type HookMatcher = HookMatcherSetting;

export type HookConfig = Partial<Record<HookEvent, HookMatcher[]>>;

/** One hook's outcome, handed to `deps.record` for audit/metrics. Fired per hook, not per event. */
export interface HookRunRecord {
  event: HookEvent;
  source: 'atom' | 'command';
  /** atom matcher/event label or the command string (truncated by the sink, not here). */
  label: string;
  outcome: 'allow' | 'deny' | 'ask' | 'mutate' | 'error' | 'timeout';
  durationMs: number;
  reason?: string;
}

export interface HookRunnerDeps {
  /** Command-hook config. A function is resolved per call so config.json edits hot-reload (the
   *  daemon swaps the backing value on a settings reload) without rebuilding the runner. */
  config: HookConfig | (() => HookConfig);
  /** Operator-managed policy command hooks that always run BEFORE user `config` hooks (so a policy
   *  deny wins and surfaces first) and are never written by the hooks settings API — a
   *  non-overridable layer for org-enforced rules. Resolved per call like `config`. Scope: SHELL
   *  command hooks only. Atom-pack hooks (`atomHooks`) run in-process and are already operator-trusted
   *  (installed by the operator, not user config), so they have no separate policy variant. */
  policy?: HookConfig | (() => HookConfig);
  atomHooks: Map<HookEvent, HookDefinition[]>;
  /** Sandbox/workspace root used as the cwd for command hooks. */
  cwd: string;
  defaultTimeoutMs?: number;
  log: Logger;
  /** Observability seam: called once per executed hook with its outcome + latency. The daemon
   *  wires this to its logger/store so deny/mutate decisions are auditable. Never throws into run(). */
  record?: (entry: HookRunRecord) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The HookOutput fields that count as a mutation — the single source for both `classify()` (audit
 *  outcome) and `apply()` (which assigns each into the decision). Add a new mutation field here AND
 *  to apply()'s assignments. */
const MUTATION_KEYS = [
  'additionalContext',
  'mutatedPrompt',
  'modelOverride',
  'mutatedToolInput',
  'updatedToolOutput',
  'mutatedRequest',
  'mutatedText',
  'continueWork'
] as const satisfies readonly (keyof HookOutput)[];

/** Events whose finalize() must run even with zero hooks — they flow the SessionStart→BeforeTurn
 *  injected-context stash. Every other event with no hooks takes the zero-allocation fast path. */
const STASH_EVENTS = new Set<HookEvent>(['SessionStart', 'BeforeTurn', 'SessionEnd']);

/** Env keys never forwarded to a command-hook subprocess (credential hygiene). */
function sanitizedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(Bun.env)) {
    if (v === undefined) continue;
    if (k.startsWith('MONAD_')) continue;
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Compiled-matcher cache: matcher strings come from static config/atom packs, so they're a small
// fixed set — compile each regex once rather than per hook evaluation. `null` = malformed pattern.
const regexCache = new Map<string, RegExp | null>();
function compileMatcher(matcher: string): RegExp | null {
  const cached = regexCache.get(matcher);
  if (cached !== undefined) return cached;
  let re: RegExp | null;
  try {
    re = new RegExp(matcher);
  } catch {
    re = null;
  }
  regexCache.set(matcher, re);
  return re;
}

/** Tool-scoped events filter by tool name via the matcher; every other event always matches. */
const TOOL_SCOPED_EVENTS = new Set<HookEvent>(['BeforeTool', 'AfterTool', 'ApprovalRequest']);
function matches(event: HookEvent, matcher: string | undefined, toolName: string | undefined): boolean {
  if (!matcher) return true;
  if (!TOOL_SCOPED_EVENTS.has(event)) return true;
  const re = compileMatcher(matcher);
  return re ? re.test(toolName ?? '') : false; // a malformed matcher matches nothing
}

export function createHookRunner(deps: HookRunnerDeps): Hooks {
  const timeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Filtered env is stable for the daemon's lifetime — compute once, not per spawn.
  const childEnv = sanitizedEnv();
  // SessionStart additionalContext stashed per session, consumed by that session's first
  // UserPromptSubmit so it reaches the opening turn's prompt.
  const sessionStartContext = new Map<string, string[]>();

  function classify(out: HookOutput | undefined): HookRunRecord['outcome'] {
    if (!out) return 'allow';
    if (out.decision === 'deny') return 'deny';
    if (out.decision === 'ask') return 'ask';
    if (MUTATION_KEYS.some((k) => out[k] !== undefined)) return 'mutate';
    return 'allow';
  }

  function record(entry: HookRunRecord): void {
    if (!deps.record) return;
    try {
      deps.record(entry);
    } catch {
      // An observability sink must never break the hook run.
    }
  }

  // A hook's own failure (throw / timeout / spawn error / bad output). `onError: 'deny'` turns it into
  // a block (fail-closed) so a security guard can't be silently skipped; otherwise it's skipped (allow).
  function onFailure(
    onError: 'allow' | 'deny' | undefined,
    source: 'atom' | 'command',
    label: string,
    input: HookInput,
    kind: 'error' | 'timeout',
    startMs: number,
    detail: string
  ): HookOutput | undefined {
    const durationMs = Date.now() - startMs;
    if (onError === 'deny') {
      const reason = `hook ${kind === 'timeout' ? 'timed out' : 'errored'} (fail-closed)`;
      deps.log.warn({ event: input.event, source, label, detail }, `${source} hook ${kind} — denied (fail-closed)`);
      record({ event: input.event, source, label, outcome: 'deny', durationMs, reason });
      return { decision: 'deny', reason };
    }
    deps.log.warn({ event: input.event, source, label, detail }, `${source} hook ${kind} — skipped`);
    record({ event: input.event, source, label, outcome: kind, durationMs });
    return undefined;
  }

  async function runAtomHook(def: HookDefinition, input: HookInput): Promise<HookOutput | undefined> {
    const t0 = Date.now();
    const label = def.matcher ? `${def.event}:${def.matcher}` : def.event;
    try {
      const out = (await def.handler(input)) ?? undefined;
      record({
        event: input.event,
        source: 'atom',
        label,
        outcome: classify(out),
        durationMs: Date.now() - t0,
        reason: out?.reason
      });
      return out;
    } catch (err) {
      return onFailure(def.onError, 'atom', label, input, 'error', t0, String(err));
    }
  }

  async function runCommandHook(spec: CommandHookSpec, input: HookInput): Promise<HookOutput | undefined> {
    const t0 = Date.now();
    const signal = AbortSignal.timeout(spec.timeoutMs ?? timeoutMs);
    try {
      // Route through the resolved per-platform shell (Git Bash → pwsh → cmd on Windows,
      // /bin/sh elsewhere) rather than hardcoding `sh`, which doesn't exist on Windows.
      const proc = Bun.spawn(shellArgv(spec.command), {
        cwd: deps.cwd,
        env: childEnv,
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: 'pipe',
        stderr: 'pipe',
        signal
      });
      // Belt-and-suspenders: Bun.spawn's signal option may not kill the child on all
      // platforms/versions. Explicitly kill when the signal fires so proc.exited resolves.
      signal.addEventListener('abort', () => proc.kill(), { once: true });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ]);
      if (signal.aborted) {
        return onFailure(
          spec.onError,
          'command',
          spec.command,
          input,
          'timeout',
          t0,
          `timeout ${spec.timeoutMs ?? timeoutMs}ms`
        );
      }
      if (code === 2) {
        const reason = stderr.trim() || 'denied by hook';
        record({
          event: input.event,
          source: 'command',
          label: spec.command,
          outcome: 'deny',
          durationMs: Date.now() - t0,
          reason
        });
        return { decision: 'deny', reason };
      }
      if (code !== 0) {
        return onFailure(spec.onError, 'command', spec.command, input, 'error', t0, `exit ${code}: ${stderr.trim()}`);
      }
      const trimmed = stdout.trim();
      if (!trimmed) {
        record({
          event: input.event,
          source: 'command',
          label: spec.command,
          outcome: 'allow',
          durationMs: Date.now() - t0
        });
        return undefined;
      }
      let out: HookOutput;
      try {
        // Validate the hook's JSON at the boundary (schema-first) rather than trusting its shape.
        out = hookOutputSchema.parse(JSON.parse(trimmed));
      } catch {
        return onFailure(
          spec.onError,
          'command',
          spec.command,
          input,
          'error',
          t0,
          'invalid hook output (non-JSON or schema mismatch)'
        );
      }
      record({
        event: input.event,
        source: 'command',
        label: spec.command,
        outcome: classify(out),
        durationMs: Date.now() - t0,
        reason: out.reason
      });
      return out;
    } catch (err) {
      return onFailure(spec.onError, 'command', spec.command, input, 'error', t0, String(err));
    }
  }

  return {
    async run(input: HookInput): Promise<HookDecision> {
      const atomList = deps.atomHooks.get(input.event);
      const config = typeof deps.config === 'function' ? deps.config() : deps.config;
      const policy = typeof deps.policy === 'function' ? deps.policy() : (deps.policy ?? {});

      // Hot-path fast path: these events fire per model-step / per tool-call, so when no hook is
      // registered for the event (the common case) skip all filtering + allocation below. Stash
      // events still need finalize() to flow SessionStart→BeforeTurn context, so they fall through.
      if (
        (atomList?.length ?? 0) === 0 &&
        (config[input.event]?.length ?? 0) === 0 &&
        (policy[input.event]?.length ?? 0) === 0 &&
        !STASH_EVENTS.has(input.event)
      ) {
        return {
          blocked: false,
          ask: false,
          allowed: false,
          additionalContext: [],
          effectivePrompt: input.prompt,
          effectiveToolInput: input.toolInput,
          effectiveToolOutput: input.toolResult,
          effectiveRequest: input.request
        };
      }

      const atoms = (atomList ?? []).filter((h) => matches(input.event, h.matcher, input.toolName));
      const matching = (cfg: HookConfig): CommandHookSpec[] =>
        (cfg[input.event] ?? []).filter((m) => matches(input.event, m.matcher, input.toolName)).flatMap((m) => m.hooks);
      // Policy command hooks run first (operator-enforced; surfaces first on deny), then user hooks.
      // Dedupe identical specs across both — one command reachable via several matchers runs once per
      // event (like Claude Code), first occurrence (policy) wins.
      const seen = new Set<string>();
      const commands = [...matching(policy), ...matching(config)].filter((spec) => {
        const key = `${spec.command} ${spec.timeoutMs ?? ''} ${spec.onError ?? ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      const decision: HookDecision = {
        blocked: false,
        ask: false,
        allowed: false,
        additionalContext: [],
        effectivePrompt: input.prompt,
        modelOverride: undefined,
        effectiveToolInput: input.toolInput,
        effectiveToolOutput: input.toolResult,
        effectiveRequest: input.request,
        effectiveText: undefined,
        continueWork: undefined
      };

      // Carry SessionStart-injected context onto the session's first UserPromptSubmit, and stash any
      // SessionStart context for that first turn. Runs even on the zero-hook fast path.
      const finalize = (): HookDecision => {
        if (input.event === 'SessionStart' && decision.additionalContext.length) {
          const prev = sessionStartContext.get(input.sessionId) ?? [];
          sessionStartContext.set(input.sessionId, [...prev, ...decision.additionalContext]);
        } else if (input.event === 'BeforeTurn') {
          const stashed = sessionStartContext.get(input.sessionId);
          if (stashed?.length) {
            decision.additionalContext = [...stashed, ...decision.additionalContext];
            sessionStartContext.delete(input.sessionId);
          }
        } else if (input.event === 'SessionEnd') {
          sessionStartContext.delete(input.sessionId); // never started a turn — drop unused context
        }
        return decision;
      };

      // Zero-cost fast path: nothing to run (still finalize so stashed context flows / clears).
      if (atoms.length === 0 && commands.length === 0) return finalize();

      // Atom hooks first (trusted, in-process — may deny before a subprocess spawns), then commands.
      const apply = (out: HookOutput | undefined): boolean => {
        if (!out) return false;
        if (out.additionalContext) decision.additionalContext.push(out.additionalContext);
        if (out.mutatedPrompt !== undefined) decision.effectivePrompt = out.mutatedPrompt;
        if (out.modelOverride !== undefined) decision.modelOverride = out.modelOverride;
        if (out.mutatedToolInput !== undefined) decision.effectiveToolInput = out.mutatedToolInput;
        if (out.updatedToolOutput !== undefined) decision.effectiveToolOutput = out.updatedToolOutput;
        if (out.mutatedRequest !== undefined) decision.effectiveRequest = out.mutatedRequest;
        if (out.mutatedText !== undefined) decision.effectiveText = out.mutatedText;
        if (out.continueWork) decision.continueWork = out.continueWork;
        if (out.decision === 'ask') decision.ask = true;
        if (out.decision === 'allow') decision.allowed = true;
        if (out.decision === 'deny') {
          decision.blocked = true;
          decision.reason = out.reason ?? 'denied by hook';
          return true; // first-block-wins
        }
        return false;
      };

      // Observe/inject-only events can't deny or chain a mutation, so fan them out concurrently and
      // apply in a stable order (atoms then commands) for deterministic context ordering.
      if (PARALLEL_HOOK_EVENTS.has(input.event)) {
        const outs = await Promise.all([
          ...atoms.map((def) => runAtomHook(def, input)),
          ...commands.map((spec) => runCommandHook(spec, input))
        ]);
        for (const out of outs) apply(out);
        return finalize();
      }

      // Mutating events run serially: build each hook's input from the current (possibly mutated)
      // effective values so mutations chain, and the first deny short-circuits.
      const inputFor = (): HookInput => ({
        ...input,
        prompt: decision.effectivePrompt,
        toolInput: decision.effectiveToolInput,
        toolResult: decision.effectiveToolOutput,
        request: decision.effectiveRequest,
        // AfterModel / AfterSubagent / AfterTurn chain via mutatedText→effectiveText: a later hook must
        // see the prior rewrite, so refresh response/subagentResult from it (else the original).
        response: decision.effectiveText ?? input.response,
        subagentResult: decision.effectiveText ?? input.subagentResult
      });

      for (const def of atoms) {
        if (apply(await runAtomHook(def, inputFor()))) return finalize();
      }
      for (const spec of commands) {
        if (apply(await runCommandHook(spec, inputFor()))) return finalize();
      }
      return finalize();
    }
  };
}
