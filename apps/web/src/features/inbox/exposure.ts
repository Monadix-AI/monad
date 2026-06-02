export interface InboxExposureTracker {
  setVisible: (itemKey: string, visible: boolean) => void;
  setPageVisible: (visible: boolean) => void;
  dispose: () => void;
}

export function createInboxExposureTracker(options: {
  dwellMs: number;
  onSeen: (itemKey: string) => void;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}): InboxExposureTracker {
  const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const visible = new Set<string>();
  const seen = new Set<string>();
  const pending = new Map<string, unknown>();
  let pageVisible = true;

  const disarm = (itemKey: string) => {
    const handle = pending.get(itemKey);
    if (handle !== undefined) cancel(handle);
    pending.delete(itemKey);
  };
  const arm = (itemKey: string) => {
    if (!pageVisible || seen.has(itemKey) || pending.has(itemKey)) return;
    const handle = schedule(() => {
      pending.delete(itemKey);
      if (!pageVisible || !visible.has(itemKey) || seen.has(itemKey)) return;
      seen.add(itemKey);
      options.onSeen(itemKey);
    }, options.dwellMs);
    pending.set(itemKey, handle);
  };

  return {
    setVisible(itemKey, isVisible) {
      if (isVisible) {
        visible.add(itemKey);
        arm(itemKey);
      } else {
        visible.delete(itemKey);
        disarm(itemKey);
      }
    },
    setPageVisible(isVisible) {
      pageVisible = isVisible;
      if (!isVisible) {
        for (const itemKey of pending.keys()) disarm(itemKey);
      } else {
        for (const itemKey of visible) arm(itemKey);
      }
    },
    dispose() {
      for (const itemKey of pending.keys()) disarm(itemKey);
      visible.clear();
    }
  };
}
