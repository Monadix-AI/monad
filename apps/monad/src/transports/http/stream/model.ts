export function getStreamSocketId(ws: unknown): string {
  const socket = ws as { id?: string; data?: { id?: string } };
  if (typeof socket.id === 'string' && socket.id) return socket.id;
  if (typeof socket.data?.id === 'string' && socket.data.id) return socket.data.id;

  const id = crypto.randomUUID();
  socket.data = { ...(socket.data ?? {}), id };
  return id;
}
