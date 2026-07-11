import type {
  ModuleId,
  RuntimeModule,
  RuntimeModuleState,
  RuntimeReloadReport,
  SerializedRuntimeError
} from './types.ts';

import { RuntimeContext } from './context.ts';
import { buildRuntimeGraph, type RuntimeGraph } from './graph.ts';
import { createRuntimeStateStore, type RuntimeStateStore } from './state.ts';

function serializeError(error: unknown): SerializedRuntimeError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}

export class RuntimeKernel<Snapshot = unknown> {
  readonly context = new RuntimeContext();
  readonly state: RuntimeStateStore;
  private readonly graph: RuntimeGraph<Snapshot>;
  private controller = new AbortController();

  constructor(modules: readonly RuntimeModule<Snapshot>[]) {
    this.graph = buildRuntimeGraph(modules);
    this.state = createRuntimeStateStore(modules);
  }

  async start(): Promise<void> {
    this.controller = new AbortController();
    this.setPhase('booting');

    for (const layer of this.graph.layers) {
      const eligible: RuntimeModule<Snapshot>[] = [];
      for (const module of layer) {
        const unavailable = (module.requires ?? []).find((id) => !this.hasOutput(id));
        if (!unavailable) {
          eligible.push(module);
          continue;
        }

        const error = new Error(`required dependency "${unavailable}" is unavailable`);
        this.patchModule(module.id, { error: serializeError(error), status: 'blocked' });
        if (module.criticality === 'required') {
          this.controller.abort();
          await this.stopCommitted();
          this.setPhase('failed');
          throw new Error(
            `required runtime module "${module.id}" is blocked by unavailable dependency "${unavailable}"`
          );
        }
      }

      const results = await Promise.allSettled(
        eligible.map(async (module) => {
          const started = Date.now();
          this.patchModule(module.id, {
            error: undefined,
            startedAt: new Date(started).toISOString(),
            status: 'starting'
          });
          const output = await module.start(this.context, this.controller.signal);
          return { durationMs: Date.now() - started, module, output };
        })
      );

      let requiredFailure: { error: unknown; module: RuntimeModule<Snapshot> } | undefined;
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const module = eligible[index] as RuntimeModule<Snapshot>;
        if (result?.status === 'fulfilled') {
          this.context.commit(module.id, result.value.output);
          this.patchModule(module.id, {
            durationMs: result.value.durationMs,
            error: undefined,
            generation: 1,
            status: 'ready'
          });
          continue;
        }

        const error = result?.reason;
        this.patchModule(module.id, {
          error: serializeError(error),
          status: module.criticality === 'required' ? 'failed' : 'degraded'
        });
        if (module.criticality === 'required') requiredFailure ??= { error, module };
      }

      if (requiredFailure) {
        this.controller.abort();
        await this.stopCommitted();
        this.setPhase('failed');
        throw new Error(
          `required runtime module "${requiredFailure.module.id}" failed: ${serializeError(requiredFailure.error).message}`
        );
      }
    }

    this.setPhase(this.isDegraded() ? 'degraded' : 'ready');
  }

  async reload(snapshot: Snapshot): Promise<RuntimeReloadReport> {
    this.setPhase('reloading');
    const reloaded: ModuleId[] = [];
    const degraded: ModuleId[] = [];

    for (const layer of this.graph.layers) {
      const reloadable = layer.filter((module) => module.reload && this.hasOutput(module.id));
      const results = await Promise.allSettled(
        reloadable.map(async (module) => {
          const started = Date.now();
          this.patchModule(module.id, { error: undefined, status: 'reloading' });
          const current = this.context.get(module.id);
          const output = await module.reload?.(current, snapshot, this.context, this.controller.signal);
          return { durationMs: Date.now() - started, module, output };
        })
      );

      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const module = reloadable[index] as RuntimeModule<Snapshot>;
        if (result?.status === 'fulfilled') {
          this.context.replace(module.id, result.value.output);
          const current = this.moduleState(module.id);
          this.patchModule(module.id, {
            durationMs: result.value.durationMs,
            error: undefined,
            generation: current.generation + 1,
            lastReloadAt: new Date().toISOString(),
            status: 'ready'
          });
          reloaded.push(module.id);
          continue;
        }

        this.patchModule(module.id, { error: serializeError(result?.reason), status: 'degraded' });
        degraded.push(module.id);
      }
    }

    this.setPhase(this.isDegraded() ? 'degraded' : 'ready');
    return { degraded: degraded.sort(), reloaded: reloaded.sort() };
  }

  async stop(): Promise<void> {
    this.controller.abort();
    this.setPhase('stopping');
    await this.stopCommitted();
  }

  private async stopCommitted(): Promise<void> {
    for (const layer of this.graph.reverseLayers) {
      const active = layer.filter((module) => this.hasOutput(module.id));
      const results = await Promise.allSettled(
        active.map(async (module) => {
          const output = this.context.get(module.id);
          await module.stop?.(output, this.context);
          return module;
        })
      );

      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const module = active[index] as RuntimeModule<Snapshot>;
        this.context.remove(module.id);
        this.patchModule(
          module.id,
          result?.status === 'rejected'
            ? { error: serializeError(result.reason), status: 'failed' }
            : { error: undefined, status: 'stopped' }
        );
      }
    }
  }

  private hasOutput(id: ModuleId): boolean {
    try {
      this.context.get(id);
      return true;
    } catch {
      return false;
    }
  }

  private isDegraded(): boolean {
    return Object.values(this.state.getState().modules).some((module) =>
      ['blocked', 'degraded', 'failed'].includes(module.status)
    );
  }

  private moduleState(id: ModuleId): RuntimeModuleState {
    const module = this.state.getState().modules[id];
    if (!module) throw new Error(`runtime state for "${id}" is unavailable`);
    return module;
  }

  private patchModule(id: ModuleId, patch: Partial<RuntimeModuleState>): void {
    const state = this.state.getState();
    this.state.setState({
      ...state,
      modules: { ...state.modules, [id]: { ...this.moduleState(id), ...patch } }
    });
  }

  private setPhase(phase: ReturnType<RuntimeStateStore['getState']>['phase']): void {
    this.state.setState({ ...this.state.getState(), phase });
  }
}
