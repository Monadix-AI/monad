/** Shared shapes for a spawned MeshAgent child. Extracted so the interactive host and the auth host
 *  agree on one definition of "an MeshAgent process" without importing each other. */
import type { SpawnSupervision } from '#/infra/spawn-supervisor.ts';

export interface MeshAgentTerminal {
  write(input: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface MeshAgentStdin {
  write(input: string): void;
  flush?(): void | Promise<void>;
  end?(): void | Promise<void>;
}

export type MeshAgentProcess = ReturnType<typeof Bun.spawn> & {
  supervision?: SpawnSupervision;
  terminal?: MeshAgentTerminal;
  stdin?: MeshAgentStdin;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
};
