import type { MeshAgentProvider, MeshAgentView } from '@monad/protocol';

export type LegacyProviderLaunchMode = 'pty' | 'json-stream' | 'gateway' | 'cli-oneshot';
type LegacyProviderCapability =
  | LegacyProviderLaunchMode
  | 'provider-approval'
  | 'approval-resolution'
  | 'structured-output'
  | 'session-resume'
  | 'rollout-json-fallback';

export interface LegacyProviderLaunchOptions {
  workingPath: string;
  extraWorkingPaths?: string[];
  launchMode?: LegacyProviderLaunchMode;
  gatewayTransport?: 'stdio' | 'ws' | 'unix';
  gatewaySocketPath?: string;
  gatewayPort?: number;
  providerSessionRef?: string;
  systemPromptFile?: string;
  skipProviderApprovals?: boolean;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  mcpConfigArgs?: string[];
}

export interface LegacyProviderLaunchSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  launchMode: LegacyProviderLaunchMode;
  gatewayTransport?: 'stdio' | 'ws' | 'unix';
  gatewayWs?: { path?: string; query?: Record<string, string>; port?: number };
  provider: MeshAgentProvider;
  approvalOwnership: 'provider-owned';
  capabilities: LegacyProviderCapability[];
}

export interface LegacyProviderConnection {
  send(frame: string): void;
  close(): void;
}

export interface LegacyProviderRuntimeHandle {
  terminal?: {
    write(input: string): void;
    resize(cols: number, rows: number): void;
    close(): void;
  };
  stdin?: {
    write(input: string): void;
    flush?(): void | Promise<void>;
    end?(): void | Promise<void>;
  };
  gateway?: LegacyProviderConnection;
  launchMode?: LegacyProviderLaunchMode;
  providerSessionRef?: string | null;
  nextRequestId?(): number;
  pendingRequests?: Map<string | number, string>;
  kill(signal?: NodeJS.Signals): void;
}

export interface LegacyProviderInitializeContext {
  workingPath: string;
  providerSessionRef?: string;
  developerInstructions?: string;
  modelName?: string;
  modelId?: string;
  reasoningEffort?: string;
  speed?: 'standard' | 'fast';
  env?: Record<string, string>;
}

export interface LegacyProviderApprovalResolution {
  requestId: string;
  allow: boolean;
  reason?: string;
  request?: Record<string, unknown>;
}

export type LegacyProviderAdapterConfig = Pick<MeshAgentView, 'command' | 'args' | 'env'>;
