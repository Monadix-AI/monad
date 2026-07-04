/** Shared shapes for a spawned native-CLI child. Extracted so the interactive host and the auth host
 *  agree on one definition of "a native-CLI process" without importing each other. */
export interface NativeCliTerminal {
  write(input: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface NativeCliStdin {
  write(input: string): void;
  flush?(): void | Promise<void>;
  end?(): void | Promise<void>;
}

export type NativeCliProcess = ReturnType<typeof Bun.spawn> & {
  terminal?: NativeCliTerminal;
  stdin?: NativeCliStdin;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
};
