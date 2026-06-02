import type { OperationSource, SessionSurface, SessionTransport } from '@monad/protocol';

export interface BuildOperationSourceInput {
  transport: SessionTransport;
  surface: SessionSurface;
  client: string;
  clientVersion?: string;
  instanceId?: string;
}

export function buildOperationSource(input: BuildOperationSourceInput): OperationSource {
  return {
    surface: input.surface,
    client: input.client,
    clientVersion: input.clientVersion,
    instanceId: input.instanceId,
    transport: input.transport
  };
}
