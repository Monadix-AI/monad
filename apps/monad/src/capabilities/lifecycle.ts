import type { MonadPaths } from '@monad/environment';
import type { RegistryLog } from '#/handlers/commands/registry.ts';
import type { SandboxSetup } from '#/platform/sandbox/service.ts';
import type { RuntimeModule } from '#/runtime/types.ts';
import type { Tool } from './tools/types.ts';

import { AtomPackRegistry } from '#/handlers/atom-pack/atom-pack-registry.ts';
import { type CommandRegistry, createCommandRegistry } from '#/handlers/commands/index.ts';
import { withCredentialsProtection, withSandboxConstraints } from './protection.ts';
import { builtinTools } from './tools/index.ts';

export interface AgentCapabilityRuntimeOptions {
  paths: MonadPaths;
  sandboxRoots: string[] | undefined;
  tools?: readonly Tool[];
  log?: RegistryLog;
}

export interface AgentCapabilityRuntime {
  registry: AtomPackRegistry;
  commandRegistry: CommandRegistry;
}

export type CreateAgentCapabilityRuntime = (options: AgentCapabilityRuntimeOptions) => AgentCapabilityRuntime;

export function createAgentCapabilityRuntime(options: AgentCapabilityRuntimeOptions): AgentCapabilityRuntime {
  const registry = new AtomPackRegistry();
  for (const tool of options.tools ?? builtinTools) {
    registry.registerTool(
      withCredentialsProtection(withSandboxConstraints(tool, options.sandboxRoots), options.paths.credentials)
    );
  }
  return { registry, commandRegistry: createCommandRegistry(options.log) };
}

export function createCapabilitiesLifecycleModule(
  options: Pick<AgentCapabilityRuntimeOptions, 'paths' | 'log'>,
  create: CreateAgentCapabilityRuntime = createAgentCapabilityRuntime
): RuntimeModule {
  return {
    id: 'capabilities',
    criticality: 'required',
    requires: ['platform.sandbox'],
    start: (context) => {
      const sandbox = context.get<SandboxSetup>('platform.sandbox');
      return Promise.resolve(
        create({
          paths: options.paths,
          sandboxRoots: sandbox.sandboxRoots,
          ...(options.log === undefined ? {} : { log: options.log })
        })
      );
    }
  };
}
