export function proxyResponseBody(upstream: Response): BodyInit | null {
  if (!upstream.body) return null;
  const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('text/event-stream')) return upstream.body;
  return closeOnReadError(upstream.body);
}

function closeOnReadError(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          ctrl.close();
          return;
        }
        ctrl.enqueue(value);
      } catch {
        ctrl.close();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch {}
    }
  });
}
