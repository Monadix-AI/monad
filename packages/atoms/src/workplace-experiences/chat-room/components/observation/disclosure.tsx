'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore } from 'react';

type DisclosureListener = () => void;

export interface ObservationDisclosureStore {
  read: (key: string) => boolean | undefined;
  subscribe: (key: string, listener: DisclosureListener) => () => void;
  write: (key: string, open: boolean) => void;
}

export function createObservationDisclosureStore(): ObservationDisclosureStore {
  const open = new Map<string, boolean>();
  const listeners = new Map<string, Set<DisclosureListener>>();
  return {
    read: (key) => open.get(key),
    subscribe: (key, listener) => {
      const bucket = listeners.get(key) ?? new Set<DisclosureListener>();
      bucket.add(listener);
      listeners.set(key, bucket);
      return () => {
        bucket.delete(listener);
        if (bucket.size === 0) listeners.delete(key);
      };
    },
    write: (key, value) => {
      if (open.get(key) === value) return;
      open.set(key, value);
      for (const listener of listeners.get(key) ?? []) listener();
    }
  };
}

const DisclosureStoreContext = createContext<ObservationDisclosureStore>(createObservationDisclosureStore());
const DisclosureScopeContext = createContext<string>('');

export function ObservationDisclosureProvider({
  children,
  store
}: {
  children: React.ReactNode;
  store: ObservationDisclosureStore;
}): React.ReactElement {
  return <DisclosureStoreContext.Provider value={store}>{children}</DisclosureStoreContext.Provider>;
}

export function ObservationDisclosureScope({
  children,
  id
}: {
  children: React.ReactNode;
  id: string;
}): React.ReactElement {
  const parent = useContext(DisclosureScopeContext);
  const scope = useMemo(() => (parent ? `${parent}/${id}` : id), [parent, id]);
  return <DisclosureScopeContext.Provider value={scope}>{children}</DisclosureScopeContext.Provider>;
}

/**
 * Expanded/collapsed state for a card inside the virtualized observation timeline. The row that owns
 * the card is unmounted whenever it scrolls out of the window, so any state held in the card itself
 * (a `useState`, or a `<details>` element's own DOM state) is destroyed and rebuilt at its default on
 * the way back. Keeping it in a store above the list is what survives that remount.
 */
export function useObservationDisclosure(key: string, defaultOpen = false): [boolean, (open: boolean) => void] {
  const store = useContext(DisclosureStoreContext);
  const scope = useContext(DisclosureScopeContext);
  const fullKey = scope ? `${scope}/${key}` : key;
  const defaultOpenRef = useRef(defaultOpen);
  defaultOpenRef.current = defaultOpen;

  const subscribe = useCallback((listener: DisclosureListener) => store.subscribe(fullKey, listener), [store, fullKey]);
  const getSnapshot = useCallback(() => store.read(fullKey) ?? defaultOpenRef.current, [store, fullKey]);
  const open = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setOpen = useCallback((next: boolean) => store.write(fullKey, next), [store, fullKey]);

  return [open, setOpen];
}
