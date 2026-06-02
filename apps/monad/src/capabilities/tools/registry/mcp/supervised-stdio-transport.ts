import type { JSONRPCMessage, Transport } from '@modelcontextprotocol/client';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/client';
import { createLogger } from '@monad/logger';

import { daemonChildProcesses } from '#/infra/daemon-child-processes.ts';
import {
  daemonTrackedProcessTreeSpawnOptions,
  type SupervisedSubprocess,
  supervisedSpawn
} from '#/infra/spawn-supervisor.ts';

const log = createLogger('mcp');
type McpSubprocess = SupervisedSubprocess<'pipe', 'pipe', 'pipe'>;

export interface SupervisedStdioTransportOptions {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class SupervisedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private process: McpSubprocess | undefined;
  private readonly readBuffer = new ReadBuffer();
  private closed = false;

  constructor(private readonly options: SupervisedStdioTransportOptions) {}

  get stderr(): null {
    return null;
  }

  get pid(): number | null {
    return this.process?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.process) throw new Error('MCP stdio transport already started');

    const process = supervisedSpawn(
      [this.options.command, ...(this.options.args ?? [])],
      {
        cwd: this.options.cwd,
        env: { ...Bun.env, ...this.options.env },
        detached: true,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
      },
      {
        ...daemonTrackedProcessTreeSpawnOptions({
          event: 'mcp.stdio_spawn',
          context: { serverName: this.options.name },
          log,
          trackLabel: 'mcp:stdio',
          tracker: daemonChildProcesses
        })
      }
    );
    this.process = process;

    void this.read(process);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const process = this.process;
    if (!process || this.closed) throw new Error('MCP stdio transport is not open');
    process.stdin.write(serializeMessage(message));
    await process.stdin.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const process = this.process;
    this.process = undefined;
    this.readBuffer.clear();
    if (process) {
      process.supervision.stop('manual', 'SIGTERM');
      await process.exited;
    }
    this.onclose?.();
  }

  private async read(process: McpSubprocess): Promise<void> {
    try {
      for await (const chunk of process.stdout as unknown as AsyncIterable<Uint8Array>) {
        this.readBuffer.append(Buffer.from(chunk));
        for (let message = this.readBuffer.readMessage(); message; message = this.readBuffer.readMessage()) {
          this.onmessage?.(message);
        }
      }
    } catch (error) {
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (!this.closed) {
        this.closed = true;
        this.process = undefined;
        this.readBuffer.clear();
        this.onclose?.();
      }
    }
  }
}
