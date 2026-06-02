import { useState } from 'react';

export function useAsyncAction(): {
  busy: boolean;
  error: string | undefined;
  run(fn: () => Promise<void>): Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, run };
}
