export type ModuleId = string;
export type ModuleCriticality = 'required' | 'optional';
export type RuntimePhase = 'booting' | 'ready' | 'degraded' | 'reloading' | 'stopping' | 'failed';
export type ModuleStatus =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'reloading'
  | 'degraded'
  | 'blocked'
  | 'failed'
  | 'stopped';

export interface RuntimeContextReader {
  get<T>(id: ModuleId): T;
  optional<T>(id: ModuleId): T | undefined;
}

export interface ModuleHealth {
  status: 'ready' | 'degraded';
  message?: string;
}

export interface RuntimeModule<Snapshot = unknown> {
  id: ModuleId;
  requires?: readonly ModuleId[];
  after?: readonly ModuleId[];
  criticality: ModuleCriticality;
  start(ctx: RuntimeContextReader, signal: AbortSignal): Promise<unknown>;
  reload?(
    current: unknown,
    snapshot: Snapshot,
    ctx: RuntimeContextReader,
    signal: AbortSignal
  ): Promise<unknown>;
  stop?(current: unknown, ctx: RuntimeContextReader): void | Promise<void>;
  health?(current: unknown): Promise<ModuleHealth>;
}

export interface SerializedRuntimeError {
  name: string;
  message: string;
}

export interface RuntimeModuleState {
  criticality: ModuleCriticality;
  status: ModuleStatus;
  generation: number;
  startedAt?: string;
  lastReloadAt?: string;
  durationMs?: number;
  error?: SerializedRuntimeError;
}

export interface RuntimeState {
  phase: RuntimePhase;
  modules: Record<ModuleId, RuntimeModuleState>;
}

export interface RuntimeReloadReport {
  reloaded: ModuleId[];
  degraded: ModuleId[];
}
