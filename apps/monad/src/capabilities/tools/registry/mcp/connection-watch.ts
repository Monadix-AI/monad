interface ObservableMcpTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export function watchMcpTransport(transport: ObservableMcpTransport, notifyDisconnect: (reason: string) => void): void {
  const protocolOnClose = transport.onclose;
  const protocolOnError = transport.onerror;
  let lastError: string | undefined;
  transport.onclose = () => {
    protocolOnClose?.();
    notifyDisconnect(lastError ?? 'MCP transport closed unexpectedly');
  };
  transport.onerror = (error) => {
    protocolOnError?.(error);
    lastError = error.message;
    notifyDisconnect(error.message);
  };
}
