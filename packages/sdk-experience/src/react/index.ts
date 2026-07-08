// Curated re-export subset of @monad/client-rtk for atom authors — every daemon-facing
// RTK Query hook an atom needs, and nothing else. This must never grow a second
// implementation of an endpoint; only re-export hooks that already exist in client-rtk.

export type { MonadApiError } from '@monad/client-rtk';

export { skipToken } from '@monad/client-rtk';

export * from './attachments.ts';
export * from './external-agent.ts';
export * from './settings-model.ts';
