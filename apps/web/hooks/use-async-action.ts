import { useState } from 'react';

export function useAsyncAction(): {
  busy: boolean;
  error: string | undefined;
  run(fn: () => Promise<void>): Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run };
}
