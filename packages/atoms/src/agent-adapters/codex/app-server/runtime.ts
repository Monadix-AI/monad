import type { MeshAgentProvider } from '@monad/protocol';
import type {
  LegacyProviderConnection,
  LegacyProviderLaunchOptions,
  LegacyProviderRuntimeHandle
} from '../../legacy/runtime.ts';

export type CodexLegacyLaunchMode = 'pty' | 'json-stream' | 'app-server' | 'cli-oneshot';
type CodexLegacyCapability =
  | CodexLegacyLaunchMode
  | 'provider-approval'
  | 'approval-resolution'
  | 'structured-output'
  | 'session-resume'
  | 'rollout-json-fallback';

export interface CodexLegacyLaunchOptions
  extends Omit<LegacyProviderLaunchOptions, 'launchMode' | 'gatewayTransport' | 'gatewaySocketPath' | 'gatewayPort'> {
  launchMode?: CodexLegacyLaunchMode;
  appServerTransport?: 'stdio' | 'ws' | 'unix';
  appServerSocketPath?: string;
  appServerPort?: number;
}

export interface CodexLegacyLaunchSpec {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  launchMode: CodexLegacyLaunchMode;
  appServerTransport?: 'stdio' | 'ws' | 'unix';
  provider: MeshAgentProvider;
  approvalOwnership: 'provider-owned';
  capabilities: CodexLegacyCapability[];
}

export interface CodexLegacyRuntimeHandle extends Omit<LegacyProviderRuntimeHandle, 'gateway' | 'launchMode'> {
  appServer?: LegacyProviderConnection;
  launchMode?: CodexLegacyLaunchMode;
}
