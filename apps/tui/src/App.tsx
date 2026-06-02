import type { SessionId } from '@monad/protocol';
import type { RootState } from './store/index.ts';

import { useSelector } from 'react-redux';

import { Layout } from './components/Layout.tsx';
import { useStream } from './hooks/useStream.ts';

function SessionStream({ sessionId }: { sessionId: SessionId }) {
  useStream(sessionId);
  return null;
}

export function App() {
  const currentSessionId = useSelector((s: RootState) => s.server.currentSessionId);

  return (
    <>
      {currentSessionId && <SessionStream sessionId={currentSessionId} />}
      <Layout />
    </>
  );
}
