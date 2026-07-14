import type { MonadClient } from '@monad/client';
import type { SessionId } from '@monad/protocol';
import type { TerminalInputBridge } from './input/terminal-input.ts';
import type { RootState } from './store/index.ts';

import { useSelector } from 'react-redux';

import { Layout } from './components/Layout.tsx';
import { useStream } from './hooks/useStream.ts';

function SessionStream({ sessionId }: { sessionId: SessionId }) {
  useStream(sessionId);
  return null;
}

export function App({
  baseUrl,
  client,
  input,
  onExitRequested
}: {
  baseUrl: string;
  client: MonadClient;
  input: TerminalInputBridge;
  onExitRequested: () => void;
}) {
  const currentSessionId = useSelector((s: RootState) => s.server.currentSessionId);

  return (
    <>
      {currentSessionId && <SessionStream sessionId={currentSessionId} />}
      <Layout
        baseUrl={baseUrl}
        client={client}
        input={input}
        onExitRequested={onExitRequested}
      />
    </>
  );
}
