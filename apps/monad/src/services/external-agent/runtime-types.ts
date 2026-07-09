/** Shared shapes for a spawned external agent child. Extracted so the interactive host and the auth host
 *  agree on one definition of "an external agent process" without importing each other. */
import type { SpawnSupervision } from '#/infra/spawn-supervisor.ts';

export interface ExternalAgentTerminal {
  write(input: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface ExternalAgentStdin {
  write(input: string): void;
  flush?(): void | Promise<void>;
  end?(): void | Promise<void>;
}

export type ExternalAgentProcess = ReturnType<typeof Bun.spawn> & {
  supervision?: SpawnSupervision;
  terminal?: ExternalAgentTerminal;
  stdin?: ExternalAgentStdin;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
};
