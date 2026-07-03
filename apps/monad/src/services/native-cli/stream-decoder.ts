export interface StreamingTextDecoder {
  decode(data: Uint8Array): string;
  flush(): string;
}

export function createStreamingTextDecoder(): StreamingTextDecoder {
  const decoder = new TextDecoder();
  return {
    decode: (data) => decoder.decode(data, { stream: true }),
    flush: () => decoder.decode()
  };
}
