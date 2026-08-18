import type { MeshAgentOutputEvent } from '@monad/sdk-atom';
import type { GatewayApprovalResolution, GatewayInitializeContext, GatewayRuntimeHandle } from './runtime.ts';

export interface GatewayHooks {
  initialize(handle: GatewayRuntimeHandle, context: GatewayInitializeContext): void;
  parseOutput(chunk: string, handle?: GatewayRuntimeHandle): MeshAgentOutputEvent[];
  sendInput(handle: GatewayRuntimeHandle, input: string): void;
  /** See `ResidentProviderDriver.echoTurnInput` — implement only for a gateway that never echoes the
   *  turn it accepted. */
  echoInput?(input: string): string | undefined;
  steer(handle: GatewayRuntimeHandle, input: string): void;
  interrupt(handle: GatewayRuntimeHandle): void;
  resolveApproval(handle: GatewayRuntimeHandle, resolution: GatewayApprovalResolution): void;
  sessionLifecycle?(handle: GatewayRuntimeHandle, action: 'archive' | 'unarchive' | 'delete'): Promise<void>;
}
