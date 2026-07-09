// Sandbox violation monitor — surfaces what the OS sandbox BLOCKED, for debugging a too-tight policy.
// macOS Seatbelt writes deny events to the unified log; we tail it (`log stream`) and parse each line
// into a structured event. Off macOS this is a no-op (bwrap/Landlock give no equivalent host-side
// stream today). Opt-in: nothing is spawned unless startViolationMonitor is called.

import type { Subprocess } from 'bun';

export interface SandboxViolation {
  /** The denied operation, e.g. `file-read-data`, `network-outbound`. */
  operation: string;
  /** The target of the denied operation (a path or address), when the log line carries one. */
  target: string;
  /** The offending process name, when present. */
  process?: string;
  pid?: number;
}

export interface ViolationMonitor {
  stop(): void;
}

// A Seatbelt deny line looks like: `Sandbox: bash(52413) deny(1) file-read-data /Users/x/.ssh/id_rsa`.
// The `deny(N) <operation> <target>` core is stable; the `proc(pid)` prefix is best-effort.
const DENY_RE = /deny\(\d+\)\s+(\S+)(?:\s+(.*\S))?/;
const PROC_RE = /([\w.-]+)\((\d+)\)\s+deny\(/;

/** Parse one unified-log message body into a violation, or null if it is not a Seatbelt deny line. */
export function parseSeatbeltViolation(message: string): SandboxViolation | null {
  const deny = DENY_RE.exec(message);
  if (!deny) return null;
  const operation = deny[1] ?? '';
  if (!operation) return null;
  const target = (deny[2] ?? '').trim();
  const proc = PROC_RE.exec(message);
  const out: SandboxViolation = { operation, target };
  if (proc) {
    out.process = proc[1];
    out.pid = Number(proc[2]);
  }
  return out;
}

// Pull the log message out of an `ndjson`-styled `log stream` line (each line is a JSON object with an
// `eventMessage`). Falls back to the raw line for non-JSON output.
function messageOf(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const obj = JSON.parse(trimmed) as { eventMessage?: unknown };
    return typeof obj.eventMessage === 'string' ? obj.eventMessage : '';
  } catch {
    return '';
  }
}

export interface ViolationMonitorOptions {
  onViolation: (v: SandboxViolation) => void;
  log?: (message: string) => void;
  /** Override the spawner (tests). Default: `log stream` on macOS. */
  spawn?: () => Subprocess<'ignore', 'pipe', 'pipe'>;
}

/**
 * Start tailing sandbox deny events. macOS only (no-op elsewhere). Returns a handle whose stop() ends
 * the tail. Each parsed deny is delivered to `onViolation`. This never blocks or fails the caller —
 * a monitor that can't start just yields no events.
 */
export function startViolationMonitor(opts: ViolationMonitorOptions): ViolationMonitor {
  const spawn = opts.spawn ?? (process.platform === 'darwin' ? defaultMacosSpawn : undefined);
  if (!spawn) return { stop: () => {} };

  let proc: Subprocess<'ignore', 'pipe', 'pipe'>;
  try {
    proc = spawn();
  } catch (err) {
    opts.log?.(`violation-monitor: could not start (${(err as Error).message})`);
    return { stop: () => {} };
  }

  void (async () => {
    try {
      for await (const chunk of proc.stdout) {
        for (const line of Buffer.from(chunk).toString('utf8').split('\n')) {
          if (!line) continue;
          const v = parseSeatbeltViolation(messageOf(line));
          if (v) opts.onViolation(v);
        }
      }
    } catch {
      /* stream ended / killed */
    }
  })();

  return {
    stop: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    }
  };
}

function defaultMacosSpawn(): Subprocess<'ignore', 'pipe', 'pipe'> {
  // Only Seatbelt sandbox denials; ndjson so each line is one parseable record.
  return Bun.spawn(
    [
      'log',
      'stream',
      '--style',
      'ndjson',
      '--predicate',
      'senderImagePath CONTAINS "Sandbox" AND eventMessage CONTAINS "deny("'
    ],
    { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
  );
}
