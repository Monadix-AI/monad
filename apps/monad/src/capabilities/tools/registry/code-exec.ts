// code_execute — pluggable backend (configured via agent.tools.codeExecBackend, default 'local').
// Managed microVM backends (E2B, Vercel Sandbox) plug in behind CodeExecBackend later.
//
// SECURITY: the local backend runs in a plain subprocess — gated (highRisk) and capped,
// but NOT truly isolated (no microVM). A snippet can do anything the daemon user can,
// same as shell_exec. For untrusted code, use a real sandbox backend.

import type { Tool } from '../types.ts';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { findGitBash } from '../backends.ts';
import { buildSandboxPolicy, sandboxedSpawn, sandboxLauncher } from '../sandbox/spawn.ts';
import { toolResult } from '../types.ts';

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MiB per stream
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

type CodeLanguage = 'python' | 'javascript' | 'bash';

interface CodeExecRequest {
  language: CodeLanguage;
  code: string;
  cwd?: string;
  timeoutMs?: number;
  /** Sandbox write boundary (the session's roots). undefined → unrestricted (no write confinement). */
  sandboxRoots?: string[];
  /** false → run unconfined on the host (target:'host'); default true applies the sandbox. */
  confine?: boolean;
  /** The session this run belongs to, so a remote launcher can reuse one off-box instance per session. */
  sessionId?: string;
  /** Session cancellation — the backend should kill the running snippet when it aborts. */
  signal?: AbortSignal;
}

export interface CodeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  backend: string;
}

export interface CodeExecBackend {
  name: string;
  isAvailable(): boolean;
  execute(req: CodeExecRequest): Promise<CodeExecResult>;
}

export class CodeExecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeExecError';
  }
}

function clip(buf: Uint8Array): string {
  const text = new TextDecoder().decode(buf);
  return text.length > MAX_OUTPUT_BYTES ? `${text.slice(0, MAX_OUTPUT_BYTES)}\n…[truncated]` : text;
}

const FILE_EXT: Record<CodeLanguage, string> = { python: 'py', javascript: 'js', bash: 'sh' };

// python is `python` on Windows (no python3 alias), `python3` elsewhere.
// bash on Windows resolves to Git Bash when available; throws otherwise (bash is POSIX-only).
function interpreter(language: CodeLanguage): string {
  if (language === 'python') return process.platform === 'win32' ? 'python' : 'python3';
  if (language === 'javascript') return 'bun';
  if (process.platform === 'win32') {
    const bash = findGitBash();
    if (!bash) throw new CodeExecError('bash is not available on Windows without Git Bash');
    return bash;
  }
  return 'bash';
}

export const localBackend: CodeExecBackend = {
  name: 'local',
  isAvailable: () => true,
  async execute(req) {
    const dir = await mkdtemp(join(tmpdir(), 'monad-code-'));
    const file = join(dir, `snippet.${FILE_EXT[req.language]}`);
    try {
      await Bun.write(file, req.code);
      const limit = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const cwd = req.cwd ?? process.cwd();
      const proc = sandboxedSpawn(
        [interpreter(req.language), file],
        { cwd, stdout: 'pipe', stderr: 'pipe' },
        // Confine writes to the session roots plus the snippet temp dir; net comes from config.
        // When sandboxRoots is undefined (unrestricted) the policy applies no write confinement.
        buildSandboxPolicy(req.sandboxRoots, [dir], req.sessionId),
        { confine: req.confine ?? true, sessionId: req.sessionId }
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, limit);
      // Race completion against abort: a killed interpreter may leave a grandchild (e.g. a
      // `sleep` spawned by a bash script) holding the stdout pipe open, so we must not block
      // on the stream read after an abort — reject promptly instead.
      const completion = (async () => {
        const [out, err] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).bytes()]);
        return { out, err, exitCode: await proc.exited };
      })();
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => {
          proc.kill('SIGKILL');
          reject(new CodeExecError('code execution aborted'));
        };
        if (req.signal?.aborted) fail();
        else req.signal?.addEventListener('abort', fail, { once: true });
      });
      try {
        const { out, err, exitCode } = req.signal ? await Promise.race([completion, aborted]) : await completion;
        if (timedOut) throw new CodeExecError(`code execution timed out after ${limit}ms`);
        return { stdout: clip(out), stderr: clip(err), exitCode, backend: 'local' };
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

const BACKENDS: Record<string, CodeExecBackend> = { local: localBackend };

let _codeExecBackend = 'local';

/** Policy for the target:'host' escape — run unconfined on the real host. */
export type HostExecPolicy = 'deny' | 'ask' | 'allow';
let _hostExec: HostExecPolicy = 'ask';

/** Call once after config load to wire up the code-exec backend from config.agent.tools. */
export function configureCodeExec(backendName: string): void {
  _codeExecBackend = backendName;
}

/** Call once after config load to set the host-execution policy (agent.sandbox.hostExec). */
export function configureHostExec(policy: HostExecPolicy): void {
  _hostExec = policy;
}

export function selectCodeExecBackend(): CodeExecBackend {
  const name = _codeExecBackend;
  const backend = BACKENDS[name];
  if (!backend) {
    throw new CodeExecError(
      `unknown code-exec backend "${name}" (built-in: ${Object.keys(BACKENDS).join(', ')}). For a real sandbox, configure an external sandbox MCP server instead.`
    );
  }
  return backend;
}

const codeExecInput = z.object({
  language: z.enum(['python', 'javascript', 'bash']),
  code: z.string().min(1),
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  // 'sandbox' (default) runs inside the OS sandbox; 'host' runs unconfined on the real machine —
  // for tasks that genuinely need host access. 'host' is always human-approved and gated by config.
  target: z.enum(['sandbox', 'host']).optional()
});

export const codeExecTool: Tool<z.infer<typeof codeExecInput>, CodeExecResult> = {
  name: 'code_execute',
  description:
    'Run a code snippet (python, javascript, or bash) and capture stdout, stderr, and exit code. Runs in the OS sandbox by default; pass target:"host" to run unconfined on the real machine (always human-approved).',
  scopes: [{ resource: 'code:execute' }],
  highRisk: true,
  // Gate only when it actually escapes the sandbox: a real host run, or a "sandbox" run on a
  // platform whose launcher isn't confining yet (so it's effectively a host run). A truly confined
  // sandbox run is safe to execute without interrupting the user — the sandbox is the control.
  needsApproval: (input) => {
    if ((input.target ?? 'sandbox') === 'host') return true;
    return sandboxLauncher().kind === 'none';
  },
  // Separate remembered approvals for host escape vs sandbox runs. 'target:host' is the dangerous
  // key the policy engine refuses to persist as a global/agent allow (see ApprovalStore guard).
  gateKey: (input) => `target:${input.target ?? 'sandbox'}`,
  inputSchema: codeExecInput,
  run: async ({ language, code, timeoutMs, target }, ctx) => {
    if (target === 'host' && _hostExec === 'deny') {
      throw new CodeExecError('host execution is disabled by policy (agent.sandbox.hostExec="deny")');
    }
    const backend = selectCodeExecBackend();
    const result = await backend.execute({
      language,
      code,
      cwd: ctx.sandboxRoots?.[0],
      sandboxRoots: ctx.sandboxRoots,
      confine: target !== 'host',
      sessionId: ctx.sessionId,
      timeoutMs
    });
    return toolResult(result);
  }
};

const codeExecTools: Tool[] = [codeExecTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => codeExecTools;
