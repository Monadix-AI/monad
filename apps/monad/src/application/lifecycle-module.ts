import type { ConfigSnapshot } from '#/config/service.ts';
import type { RuntimeContext } from '#/runtime/context.ts';
import type { RuntimeModule } from '#/runtime/types.ts';

export interface ApplicationCore {
  store: unknown;
  sandbox: unknown;
  model: unknown;
  capabilities: unknown;
  atoms: unknown;
  skills: unknown;
  mcp: unknown;
}

export interface DaemonApplicationLifecycle {
  reload(snapshot: ConfigSnapshot): Promise<void>;
  stop(): Promise<void>;
}

export interface ApplicationLifecycleOptions<T extends DaemonApplicationLifecycle> {
  start(core: ApplicationCore): Promise<T>;
}

function coreFrom(context: RuntimeContext): ApplicationCore {
  return {
    store: context.get('store'),
    sandbox: context.get('platform.sandbox'),
    model: context.get('agent.model'),
    capabilities: context.get('capabilities'),
    atoms: context.get('atoms'),
    skills: context.get('capabilities.skills'),
    mcp: context.get('capabilities.mcp')
  };
}

export function createApplicationLifecycleModule<T extends DaemonApplicationLifecycle>(
  options: ApplicationLifecycleOptions<T>
): RuntimeModule<ConfigSnapshot> {
  return {
    id: 'application',
    criticality: 'required',
    requires: [
      'store',
      'platform.sandbox',
      'agent.model',
      'capabilities',
      'atoms',
      'capabilities.skills',
      'capabilities.mcp'
    ],
    start: (context) => options.start(coreFrom(context)),
    async reload(current, snapshot) {
      const application = current as T;
      await application.reload(snapshot);
      return application;
    },
    stop: (current) => (current as T).stop()
  };
}
