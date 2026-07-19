import type { MeshAgentAppServerConnection } from '#/services/mesh-agent/types.ts';

/** The child stdin pipe an `app-server: stdio` launch owns: frames are newline-delimited JSON lines
 *  written to the process's stdin, flushed so they aren't held in the pipe buffer. */
interface AppServerStdioPipe {
  write(input: string): void;
  flush?(): void | Promise<void>;
  end?(): void | Promise<void>;
}

/**
 * Wrap the child's stdin pipe as the transport-neutral `MeshAgentAppServerConnection` (the `stdio`
 * leg of an app-server launch). `send` writes a frame and flushes the pipe so codex isn't stalled
 * waiting on a buffered line; `close` ends the pipe. The adapter sees the same `send`/`close` shape
 * it gets from the ws transport, so it never branches on how the bytes travel.
 */
export function connectAppServerStdio(pipe: AppServerStdioPipe | undefined): MeshAgentAppServerConnection {
  if (!pipe) throw new Error('app-server stdio transport requires the child stdin pipe');
  return {
    send: (frame) => {
      pipe.write(frame);
      void pipe.flush?.();
    },
    close: () => void pipe.end?.()
  };
}
