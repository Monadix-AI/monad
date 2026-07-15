// code_execute — pluggable backend (configured via agent.tools.codeExecBackend).
//
// Backends:
//   follow-system (default, alias: local) — delegates to the active OS sandbox launcher via
//     sandboxedSpawn; whatever launcher is configured (Seatbelt, Docker, E2B, none) applies.
//   docker — forces a disposable Docker/Podman container regardless of the OS sandbox setting.
//   e2b   — forces an E2B cloud microVM regardless of the OS sandbox setting.
//
// SECURITY: 'follow-system' with launcher kind:'none' runs in a plain subprocess — gated
// (highRisk) and capped, but NOT truly isolated. For strong isolation use docker or e2b.

import type { SandboxProcess } from '@monad/sdk-atom';
import type { Tool } from '../types.ts';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSandboxPolicy,
  configureSandboxBackendOptions,
  resolveRegisteredSandboxLauncher,
  sandboxedSpawn,
  sandboxLauncher
} from '@monad/sandbox';
import { z } from 'zod';

import { findGitBash } from '../backends.ts';
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
  /** The session's bound agent, so a per-agent launcher (the VM backend) reuses one instance per agent. */
  agentId?: string;
  /** Session cancellation — the backend should kill the running snippet when it aborts. */
  signal?: AbortSignal;
  /** Per-call e2b API key override (from config, resolved before reaching here). */
  e2bCredential?: string;
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

// Docker and E2B backends run Linux containers regardless of host OS — always use Linux names.
function containerInterpreter(language: CodeLanguage): string {
  if (language === 'python') return 'python3';
  if (language === 'javascript') return 'bun';
  return 'bash';
}

// Shared helper: drain a SandboxProcess's stdout/stderr with a timeout + abort signal.
async function drainProcess(
  proc: SandboxProcess,
  req: Pick<CodeExecRequest, 'timeoutMs' | 'signal'>,
  backendName: string
): Promise<CodeExecResult> {
  const limit = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGKILL');
  }, limit);
  const completion = (async () => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).bytes(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).bytes()
    ]);
    return { out, err, exitCode: await proc.exited };
  })();
  // Suppress unhandled rejection when the abort path wins the race and completion later fails.
  completion.catch(() => {});
  let abortCleanup: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => {
      proc.kill('SIGKILL');
      reject(new CodeExecError('code execution aborted'));
    };
    if (req.signal?.aborted) {
      fail();
    } else if (req.signal) {
      const sig = req.signal;
      sig.addEventListener('abort', fail, { once: true });
      abortCleanup = () => sig.removeEventListener('abort', fail);
    }
  });
  try {
    const { out, err, exitCode } = req.signal ? await Promise.race([completion, aborted]) : await completion;
    if (timedOut) throw new CodeExecError(`code execution timed out after ${limit}ms`);
    return { stdout: clip(out), stderr: clip(err), exitCode, backend: backendName };
  } finally {
    clearTimeout(timer);
    abortCleanup?.();
  }
}

// 'follow-system' (alias 'local'): routes through sandboxedSpawn → activeLauncher.
// Whatever OS sandbox the daemon has selected (Seatbelt / Docker / E2B / none) applies.
export const followSystemBackend: CodeExecBackend = {
  name: 'follow-system',
  isAvailable: () => true,
  async execute(req) {
    const dir = await mkdtemp(join(tmpdir(), 'monad-code-'));
    const file = join(dir, `snippet.${FILE_EXT[req.language]}`);
    try {
      await Bun.write(file, req.code);
      const cwd = req.cwd ?? process.cwd();
      const proc = sandboxedSpawn(
        [interpreter(req.language), file],
        { cwd, stdout: 'pipe', stderr: 'pipe' },
        // Confine writes to the session roots plus the snippet temp dir; net comes from config.
        // When sandboxRoots is undefined (unrestricted) the policy applies no write confinement.
        buildSandboxPolicy(req.sandboxRoots, [dir], req.sessionId, req.agentId),
        { confine: req.confine ?? true, sessionId: req.sessionId, agentId: req.agentId }
      );
      return await drainProcess(proc as unknown as SandboxProcess, req, 'follow-system');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

// 'docker': forces a fresh Docker/Podman container per run, regardless of OS sandbox config.
// The temp dir is mounted rw so the interpreter can read the staged snippet file.
const dockerCodeExecBackend: CodeExecBackend = {
  name: 'docker',
  isAvailable: () => Boolean(resolveRegisteredSandboxLauncher('docker')?.spawn),
  async execute(req) {
    const launcher = resolveRegisteredSandboxLauncher('docker');
    if (!launcher?.spawn) throw new CodeExecError('docker backend: no launcher is registered');
    await launcher.prepare?.();
    if (!(launcher.isAvailable?.() ?? true))
      throw new CodeExecError('docker backend: no container runtime available (install Docker or Podman)');
    const dir = await mkdtemp(join(tmpdir(), 'monad-code-'));
    const file = join(dir, `snippet.${FILE_EXT[req.language]}`);
    try {
      await Bun.write(file, req.code);
      // Docker runs in an isolated container — only the temp snippet dir needs to be writable.
      // Passing [dir] as writableRoots (not undefined) prevents the docker launcher from falling
      // through to its unrestricted-mode branch that would mount the entire host root rw.
      const policy = buildSandboxPolicy([dir], []);
      const proc = launcher.spawn(
        [containerInterpreter(req.language), file],
        { cwd: dir, sessionId: req.sessionId, agentId: req.agentId },
        policy
      );
      return await drainProcess(proc, req, 'docker');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

// 'e2b': forces an E2B cloud microVM per run (or reuses a session-scoped one).
// e2bLauncher.spawn's stageLocalFiles uploads the local snippet to the remote sandbox.
const e2bCodeExecBackend: CodeExecBackend = {
  name: 'e2b',
  isAvailable: () => Boolean(_e2bApiKey && resolveRegisteredSandboxLauncher('e2b')?.spawn),
  async execute(req) {
    const apiKey = req.e2bCredential ?? _e2bApiKey;
    if (!apiKey) throw new CodeExecError('e2b backend: no API key configured (set agent.tools.codeExecE2b.apiKey)');
    const launcher = resolveRegisteredSandboxLauncher('e2b');
    if (!launcher?.spawn) throw new CodeExecError('e2b backend: no launcher is registered');
    const dir = await mkdtemp(join(tmpdir(), 'monad-code-'));
    const file = join(dir, `snippet.${FILE_EXT[req.language]}`);
    try {
      await Bun.write(file, req.code);
      // TODO(P2): pass templateId from config (codeExecE2b.templateId) once the field is added.
      const proc = launcher.spawn(
        [containerInterpreter(req.language), file],
        { cwd: '/home/user', sessionId: req.sessionId, agentId: req.agentId, credential: apiKey },
        {}
      );
      return await drainProcess(proc, req, 'e2b');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
};

// Keep 'local' as a backward-compatible alias for 'follow-system'.
const BACKENDS: Record<string, CodeExecBackend> = {
  'follow-system': followSystemBackend,
  local: followSystemBackend,
  docker: dockerCodeExecBackend,
  e2b: e2bCodeExecBackend
};

let _codeExecBackend = 'follow-system';
let _e2bApiKey: string | undefined;

/** Policy for the target:'host' escape — run unconfined on the real host. */
export type HostExecPolicy = 'deny' | 'ask' | 'allow';
let _hostExec: HostExecPolicy = 'ask';

export interface CodeExecConfig {
  backend: string;
  e2bApiKey?: string;
  dockerImage?: string;
}

/** Call once after config load to wire up the code-exec backend from config.agent.tools. */
export function configureCodeExec(cfg: string | CodeExecConfig): void {
  if (typeof cfg === 'string') {
    _codeExecBackend = cfg;
    return;
  }
  _codeExecBackend = cfg.backend;
  _e2bApiKey = cfg.e2bApiKey;
  // agent.tools.codeExecDocker.image is a code-exec-backend-specific override of the container image;
  // when set it wins over agent.sandbox.dockerImage on the shared backend-options seam.
  if (cfg.dockerImage) configureSandboxBackendOptions({ dockerImage: cfg.dockerImage });
}

/** Call once after config load to set the host-execution policy (agent.sandbox.hostExec). */
export function configureHostExec(policy: HostExecPolicy): void {
  _hostExec = policy;
}

export async function prepareCodeExecBackend(kind: 'docker' | 'e2b'): Promise<boolean> {
  const launcher = resolveRegisteredSandboxLauncher(kind);
  if (!launcher?.spawn) return false;
  if (kind === 'e2b') return Boolean(_e2bApiKey);
  await launcher.prepare?.();
  return launcher.isAvailable?.() ?? true;
}

export async function initializeDockerCodeExec(image: string): Promise<CodeExecResult> {
  configureSandboxBackendOptions({ dockerImage: image });
  return dockerCodeExecBackend.execute({ language: 'bash', code: 'exit 0' });
}

export function selectCodeExecBackend(): CodeExecBackend {
  const name = _codeExecBackend;
  const backend = BACKENDS[name];
  if (!backend) {
    throw new CodeExecError(
      `unknown code-exec backend "${name}" (built-in: follow-system, docker, e2b). For a real sandbox, configure an external sandbox MCP server instead.`
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
    // Docker and E2B are always confined — no approval needed even without an OS launcher.
    const b = _codeExecBackend;
    if (b === 'docker' || b === 'e2b') return false;
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
    if (!backend.isAvailable()) {
      if (backend.name === 'docker') {
        throw new CodeExecError(
          'code_execute: Docker/Podman is not running — start Docker Desktop or run `podman machine start`, then retry. ' +
            'To use a different backend, update agent.tools.codeExecBackend in settings.'
        );
      }
      if (backend.name === 'e2b') {
        throw new CodeExecError(
          'code_execute: E2B backend has no API key — set agent.tools.codeExecE2b.apiKey in config or switch to a different backend in settings.'
        );
      }
      throw new CodeExecError(`code_execute: backend "${backend.name}" is not available`);
    }
    const result = await backend.execute({
      language,
      code,
      cwd: ctx.sandboxRoots?.[0],
      sandboxRoots: ctx.sandboxRoots,
      confine: target !== 'host',
      sessionId: ctx.sessionId,
      agentId: ctx.agentId,
      timeoutMs,
      e2bCredential: _e2bApiKey
    });
    return toolResult(result);
  }
};

const codeExecTools: Tool[] = [codeExecTool as Tool];

import type { ToolModule } from './contract.ts';
// Uniform module entry. Static module — no boot deps.
export const register: ToolModule = () => codeExecTools;
