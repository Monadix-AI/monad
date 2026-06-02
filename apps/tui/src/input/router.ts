export type InputLayer = 'approval' | 'modal' | 'menu' | 'control' | 'page' | 'global';

const LAYER_PRIORITY: Record<InputLayer, number> = {
  approval: 500,
  modal: 400,
  menu: 300,
  control: 200,
  page: 100,
  global: 0
};

export interface RoutedInput<T> {
  input: T;
  key: unknown;
}

export class InputRouter<T = string> {
  private readonly handlers: Array<{ handler: (event: RoutedInput<T>) => boolean; layer: InputLayer }> = [];

  register(layer: InputLayer, handler: (event: RoutedInput<T>) => boolean): () => void {
    const binding = { handler, layer };
    this.handlers.push(binding);
    return () => {
      const index = this.handlers.indexOf(binding);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }

  route(event: RoutedInput<T>): boolean {
    return [...this.handlers]
      .sort((a, b) => LAYER_PRIORITY[b.layer] - LAYER_PRIORITY[a.layer])
      .some((binding) => binding.handler(event));
  }
}
