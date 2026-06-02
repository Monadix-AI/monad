import type { MeshAgentOutputEvent } from '@monad/sdk-atom';
import type { GatewayApprovalResolution, GatewayInitializeContext, GatewayRuntimeHandle } from './runtime.ts';

export interface GatewayHooks {
  initialize(handle: GatewayRuntimeHandle, context: GatewayInitializeContext): void;
  parseOutput(chunk: string, handle?: GatewayRuntimeHandle): MeshAgentOutputEvent[];
  sendInput(handle: GatewayRuntimeHandle, input: string): void;
  steer(handle: GatewayRuntimeHandle, input: string): void;
  interrupt(handle: GatewayRuntimeHandle): void;
  resolveApproval(handle: GatewayRuntimeHandle, resolution: GatewayApprovalResolution): void;
}
