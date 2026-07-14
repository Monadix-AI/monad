export interface FocusRegion {
  active: boolean;
  actions?: Partial<Record<'drag' | 'press' | 'release' | 'scroll', string>>;
  height: number;
  id: string;
  order: number;
  width: number;
  x: number;
  y: number;
}

export class FocusRegistry {
  private currentId: string | null = null;
  private readonly regions = new Map<string, FocusRegion>();

  register(region: FocusRegion): () => void {
    this.regions.set(region.id, region);
    return () => {
      this.regions.delete(region.id);
      if (this.currentId === region.id) this.currentId = null;
    };
  }

  focus(id: string): boolean {
    const region = this.regions.get(id);
    if (!region?.active) return false;
    this.currentId = id;
    return true;
  }

  next(): string | null {
    return this.cycle(1);
  }

  previous(): string | null {
    return this.cycle(-1);
  }

  hit(column: number, row: number): FocusRegion | undefined {
    return this.activeRegions()
      .sort((a, b) => b.order - a.order)
      .find(
        (region) =>
          column >= region.x && column < region.x + region.width && row >= region.y && row < region.y + region.height
      );
  }

  private activeRegions(): FocusRegion[] {
    return [...this.regions.values()].filter((region) => region.active);
  }

  private cycle(delta: 1 | -1): string | null {
    const regions = this.activeRegions().sort((a, b) => a.order - b.order);
    if (regions.length === 0) return null;
    const current = regions.findIndex((region) => region.id === this.currentId);
    const start = current < 0 ? (delta === 1 ? -1 : 0) : current;
    const next = regions[(start + delta + regions.length) % regions.length];
    this.currentId = next?.id ?? null;
    return this.currentId;
  }
}
