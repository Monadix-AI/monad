interface StreamingTextDecoder {
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

/** Per-stream streaming decoders for raw provider capture. Packets are sliced at OS pipe
 *  boundaries, so a multi-byte character can straddle two of them; decoding each packet with a
 *  fresh TextDecoder turns both halves into U+FFFD. stdout and stderr are independent byte
 *  streams and must never share decoder state. */
export function createRawStreamDecoders(): Record<'stdout' | 'stderr', StreamingTextDecoder> {
  return { stdout: createStreamingTextDecoder(), stderr: createStreamingTextDecoder() };
}

export function createStreamingTerminalTextDecoder(): StreamingTextDecoder {
  const decoder = createStreamingTextDecoder();
  let pendingCR = false;
  const normalize = (chunk: string, flush: boolean): string => {
    let text = pendingCR ? `\r${chunk}` : chunk;
    pendingCR = text.endsWith('\r');
    if (pendingCR) text = text.slice(0, -1);
    text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (flush && pendingCR) {
      pendingCR = false;
      return `${text}\n`;
    }
    return text;
  };
  return {
    decode: (data) => normalize(decoder.decode(data), false),
    flush: () => normalize(decoder.flush(), true)
  };
}
