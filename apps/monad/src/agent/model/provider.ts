// The provider registry. The provider CONTRACT (ModelProvider) lives in @monad/sdk-atom and is
// ai-sdk-free; agent-core only holds the registry + resolves providers through it, never touching
// a concrete provider's implementation. First-party providers (which use ai-sdk internally) live
// in @monad/atoms and are registered into this registry by the daemon.

import type { ModelProvider } from '@monad/sdk-atom';

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type { ModelProvider } from '@monad/sdk-atom';

export interface DiscoverResult {
  /** Provider types that were newly registered (or re-registered) in this scan. */
  registered: string[];
  /** Files that failed to load — one entry per bad atom pack, never throws. */
  errors: Array<{ file: string; error: string }>;
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): this {
    this.providers.set(provider.type, provider);
    return this;
  }

  get(type: string): ModelProvider | undefined {
    return this.providers.get(type);
  }

  has(type: string): boolean {
    return this.providers.has(type);
  }

  types(): string[] {
    return Array.from(this.providers.keys());
  }

  // Errors are collected per-file so one bad atom pack never blocks the others.
  // Safe to call repeatedly — providers are replaced in-place on re-scan.
  async discover(dir: string): Promise<DiscoverResult> {
    const registered: string[] = [];
    const errors: Array<{ file: string; error: string }> = [];

    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return { registered, errors };
    }

    const jsFiles = entries.filter((f) => f.endsWith('.js'));

    await Promise.all(
      jsFiles.map(async (filename) => {
        const filePath = join(dir, filename);
        const url = `${Bun.pathToFileURL(filePath).href}?v=${Date.now()}`;
        try {
          const mod = (await import(url)) as { default?: unknown };
          const providers = Array.isArray(mod.default) ? mod.default : [mod.default];
          for (const p of providers) {
            if (
              !p ||
              typeof (p as ModelProvider).type !== 'string' ||
              typeof (p as ModelProvider).stream !== 'function'
            ) {
              errors.push({ file: filename, error: 'default export must be a ModelProvider or ModelProvider[]' });
              continue;
            }
            this.register(p as ModelProvider);
            registered.push((p as ModelProvider).type);
          }
        } catch (err) {
          errors.push({ file: filename, error: err instanceof Error ? err.message : String(err) });
        }
      })
    );

    return { registered, errors };
  }
}
