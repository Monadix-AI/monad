import type { AgentConfig, McpServerConfig, ModelProfile, MonadConfig, MonadPaths, Provider } from '@monad/home';
import type { ImportSettingsItem, ImportSettingsSource, ModelRoles } from '@monad/protocol';
import type { ConfigBus } from '#/services/config-bus.ts';

export type KnownSource = Exclude<ImportSettingsSource, 'auto'>;

type Payload =
  | { kind: 'mcpServer'; server: McpServerConfig }
  | { kind: 'modelProvider'; provider: Provider }
  | { kind: 'modelProfile'; profile: ModelProfile; makeDefault?: boolean }
  | { kind: 'modelRoles'; roles: ModelRoles }
  | { kind: 'credential'; providerId: string; label: string; accessToken: string; authType?: 'api_key' | 'oauth' }
  | { kind: 'skill'; dir: string; name: string }
  | { kind: 'sandbox'; mode: MonadConfig['sandbox']['mode'] }
  | { kind: 'approval'; approvalPolicy: string }
  | {
      kind: 'agent';
      name: string;
      description?: string;
      model?: string;
      prompt: string;
      framework?: AgentConfig['framework'];
    }
  | { kind: 'manual' };

export interface PlannedItem extends Omit<ImportSettingsItem, 'hash'> {
  payload: Payload;
}

export interface ParsedImport {
  from: KnownSource;
  path: string;
  items: PlannedItem[];
  warnings: string[];
}

export interface SettingsImportDeps {
  paths: MonadPaths;
  configBus?: ConfigBus;
  mcpReconnect?: (name: string) => Promise<void>;
}
