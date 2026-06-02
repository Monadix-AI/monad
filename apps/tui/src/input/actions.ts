import type { ActionBinding } from './types.ts';

export class ActionRegistry {
  private readonly bindings = new Set<ActionBinding>();

  register(binding: ActionBinding): () => void {
    this.bindings.add(binding);
    return () => this.bindings.delete(binding);
  }

  dispatch(matches: (binding: ActionBinding) => boolean): boolean {
    const binding = [...this.bindings]
      .filter((candidate) => candidate.enabled !== false && matches(candidate))
      .sort((a, b) => b.priority - a.priority)[0];
    if (!binding) return false;
    binding.run();
    return true;
  }
}
