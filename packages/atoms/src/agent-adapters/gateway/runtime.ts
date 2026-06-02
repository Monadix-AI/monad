export interface GatewayConnection {
  send(frame: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface GatewayRuntimeHandle {
  gateway?: GatewayConnection;
  providerSessionRef?: string | null;
  nextRequestId?(): number;
  pendingRequests?: Map<string | number, string>;
}

export interface GatewayInitializeContext {
  workingPath: string;
  providerSessionRef?: string;
  modelName?: string;
  modelId?: string;
  env?: Record<string, string>;
  adapterSettings?: Record<string, string | boolean>;
}

export interface GatewayApprovalResolution {
  requestId: string;
  allow: boolean;
  reason?: string;
}
