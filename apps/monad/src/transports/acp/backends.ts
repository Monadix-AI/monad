// ACP-delegating execution backends: fs reads/writes and shell commands run in the connected
// editor via reverse-RPC (fs/* and terminal/*), so edits surface as reviewable diffs and commands
// run in the editor's own terminal. Lives under transports/acp, not src/agent, so the agent loop never imports the SDK.

import type { AgentContext } from '@agentclientprotocol/sdk';
import type { SessionId } from '@monad/protocol';
import type { FsBackend, TerminalBackend } from '#/capabilities/tools/types.ts';

import { shellArgv } from '#/capabilities/tools';

const OUTPUT_BYTE_LIMIT = 1024 * 1024; // mirror the sandbox shell cap
const POLL_INTERVAL_MS = 200; // how often to poll the client terminal for live output

export function createAcpFsBackend(conn: AgentContext, sessionId: SessionId): FsBackend {
  return {
    delegated: true,
    async readTextFile(path, opts) {
      const { content } = await conn.request('fs/read_text_file', {
        sessionId,
        path,
        line: opts?.offset ?? null,
        limit: opts?.limit ?? null
      });
      return content;
    },
    async writeTextFile(path, content) {
      await conn.request('fs/write_text_file', { sessionId, path, content });
      return { path, bytesWritten: Buffer.byteLength(content, 'utf8') };
    }
  };
}

export function createAcpTerminalBackend(conn: AgentContext, sessionId: SessionId): TerminalBackend {
  return {
    delegated: true,
    async exec({ command, cwd, timeoutMs, signal, onChunk }) {
      // Array argv → exec directly; string → wrap in the platform shell (Git Bash on Windows).
      const argv = Array.isArray(command) ? command : shellArgv(command);
      const [bin, ...args] = argv;
      const { terminalId } = await conn.request('terminal/create', {
        sessionId,
        command: bin ?? '',
        args,
        cwd: cwd ?? null,
        outputByteLimit: OUTPUT_BYTE_LIMIT
      });
      const kill = () => conn.request('terminal/kill', { terminalId, sessionId }).catch(() => {});
      const currentOutput = () => conn.request('terminal/output', { terminalId, sessionId });
      const waitForExit = () => conn.request('terminal/wait_for_exit', { terminalId, sessionId });
      const release = () => conn.request('terminal/release', { terminalId, sessionId }).catch(() => {});
      let timedOut = false;
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            void kill();
          }, timeoutMs)
        : undefined;
      const onAbort = () => void kill();
      signal?.addEventListener('abort', onAbort, { once: true });
      // ACP terminal output is poll-based; while the command runs, poll and stream cumulative output.
      let polling = true;
      let last = '';
      const poller = onChunk
        ? (async () => {
            while (polling) {
              await Bun.sleep(POLL_INTERVAL_MS);
              if (!polling) break;
              try {
                const cur = await currentOutput();
                if (cur.output !== last) {
                  last = cur.output;
                  onChunk(cur.output);
                }
              } catch {
                break; // terminal released/killed — stop polling
              }
            }
          })()
        : undefined;
      try {
        const exit = await waitForExit();
        const out = await currentOutput();
        // ACP merges stdout+stderr into one stream; surface it as stdout.
        // Use exitStatus from waitForExit (always present on completion) not from currentOutput
        // (which may return null if polled after the terminal has been released).
        return {
          stdout: out.output,
          stderr: '',
          exitCode: exit.exitCode ?? (timedOut ? 124 : 0),
          timedOut
        };
      } finally {
        polling = false;
        await poller;
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        await release();
      }
    }
  };
}

// isDelegableTool moved to @/capabilities/tools (the daemon's configureRuntime now sets the toolFilter for
// delegated sessions, so the predicate must live where both the bridge and the daemon can import it).
