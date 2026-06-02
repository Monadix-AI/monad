export type { ConnectionState } from '@/transports/jsonrpc/connection.ts';

export { closeConnection, consumeToken, createConnectionState } from '@/transports/jsonrpc/connection.ts';
export { handleRpcMessage } from '@/transports/jsonrpc/handler.ts';
