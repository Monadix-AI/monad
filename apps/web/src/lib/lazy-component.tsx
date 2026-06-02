import type { ComponentType, ReactElement } from 'react';

import { lazy, Suspense } from 'react';

export function lazyComponent<Props extends object>(
  load: () => Promise<ComponentType<Props>>,
  Loading: ComponentType
): ComponentType<Props> {
  const Component = lazy(async () => ({ default: await load() }));
  return function LazyComponent(props: Props): ReactElement {
    return (
      <Suspense fallback={<Loading />}>
        <Component {...props} />
      </Suspense>
    );
  };
}
