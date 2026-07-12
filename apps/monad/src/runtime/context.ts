import type { ModuleId, RuntimeContextReader } from './types.ts';

export class RuntimeContext implements RuntimeContextReader {
  private readonly outputs = new Map<ModuleId, unknown>();

  get<T>(id: ModuleId): T {
    if (!this.outputs.has(id)) throw new Error(`runtime output "${id}" is unavailable`);
    return this.outputs.get(id) as T;
  }

  optional<T>(id: ModuleId): T | undefined {
    return this.outputs.get(id) as T | undefined;
  }

  commit(id: ModuleId, output: unknown): void {
    if (this.outputs.has(id)) throw new Error(`runtime output "${id}" is already committed`);
    this.outputs.set(id, output);
  }

  replace(id: ModuleId, output: unknown): unknown {
    const previous = this.get(id);
    this.outputs.set(id, output);
    return previous;
  }

  remove(id: ModuleId): unknown | undefined {
    const previous = this.outputs.get(id);
    this.outputs.delete(id);
    return previous;
  }
}
