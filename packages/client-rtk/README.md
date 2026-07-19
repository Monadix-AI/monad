# @monad/client-rtk

RTK Query layer over the daemon control API. One cache, one set of endpoints, and
one set of typed React hooks shared by every React client (web / tui / desktop /
mobile). The transport stays in [`@monad/client`](../client)'s
`MonadClient`; this package adds caching, tag-based invalidation, request
de-duplication, live streaming, and hooks on top.

The `MonadClient` is injected per-store via the thunk `extraArgument`, so the api
slice never hardcodes a base URL — each app supplies its own configured client.

## Quick start (app with no store)

```tsx
import { Provider } from 'react-redux';
import { MonadClient } from '@monad/client';
import { createMonadStore } from '@monad/client-rtk';

const client = new MonadClient({ baseUrl: '/api/daemon' });
const store = createMonadStore({ client });

export function Root({ children }: { children: React.ReactNode }) {
  return <Provider store={store}>{children}</Provider>;
}
```

```tsx
import { useListSessionsQuery, useCreateSessionMutation } from '@monad/client-rtk';

function Sessions() {
  const { data: sessions = [], isLoading } = useListSessionsQuery();
  const [createSession] = useCreateSessionMutation();
  // createSession invalidates the Sessions tag → the list refetches automatically.
  return <button onClick={() => createSession('new chat')}>+</button>;
}
```

## Live transcript and generation streaming

`useStreamUiItemsQuery` maintains the bounded, server-projected transcript for a
session. While a visible message is generating, `useStreamMessageGenerationQuery`
opens that message's scoped SSE and closes it immediately when the final subscriber
leaves.

```tsx
import {
  useSendMessageMutation,
  useStreamMessageGenerationQuery,
  useStreamUiItemsQuery
} from '@monad/client-rtk';

function Transcript({ sessionId, streamingMessageId }) {
  const { data } = useStreamUiItemsQuery(sessionId);
  useStreamMessageGenerationQuery(
    { sessionId, messageId: streamingMessageId },
    { skip: !streamingMessageId }
  );
  const [send] = useSendMessageMutation();
  return (
    <>
      {data?.items.map((item) => <p key={`${item.kind}:${item.id}`}>{item.kind}</p>)}
      <button onClick={() => send({ sessionId, text: 'hi' })}>send</button>
    </>
  );
}
```

## Model settings

```tsx
import {
  useListProvidersQuery,
  useListModelsQuery,
  useTestConnectionMutation,
  useSetDefaultMutation
} from '@monad/client-rtk';
```

Endpoints + their cache tags:

| Hook | Tag(s) | Invalidated by |
| --- | --- | --- |
| `useListProvidersQuery` | `Providers` | set/delete provider |
| `useListProfilesQuery` | `Profiles`, `Default` | set/delete profile, set default |
| `useGetDefaultQuery` | `Default` | set default, delete profile |
| `useListModelsQuery(id)` | `Models:id` | delete provider |
| `useListCredentialsQuery(id)` | `Credentials:id` | add/delete/test credential, delete provider |

Mutations: `useSetProviderMutation`, `useDeleteProviderMutation`,
`useSetProfileMutation`, `useDeleteProfileMutation`, `useSetDefaultMutation`,
`useAddCredentialMutation`, `useDeleteCredentialMutation`,
`useTestCredentialMutation`, `useTestConnectionMutation`, `useGenerateMutation`,
`useSendMessageMutation`, `useCreateSessionMutation`.

## App with an existing store (e.g. tui)

Merge the reducer + middleware and wire the client as the extraArgument:

```ts
import { configureStore } from '@reduxjs/toolkit';
import { setupListeners } from '@reduxjs/toolkit/query/react';
import { monadApi } from '@monad/client-rtk';

export const store = configureStore({
  reducer: {
    [monadApi.reducerPath]: monadApi.reducer,
    server: serverSlice.reducer,
    modelSettings: modelSettingsSlice.reducer
  },
  middleware: (getDefault) =>
    getDefault({ thunk: { extraArgument: { client } } }).concat(monadApi.middleware)
});
setupListeners(store.dispatch);
```

The `client` MUST be on `thunk.extraArgument.client`, or endpoints throw a clear
error. This is the only contract the api slice depends on.
