import type { MeshAgentAuthSessionView } from '@monad/protocol';

import {
  useGetMeshAgentAuthQuery,
  useHeartbeatMeshAgentAuthMutation,
  useInputMeshAgentAuthMutation,
  useStopMeshAgentAuthMutation
} from '@monad/client-rtk';
import { isProductIconId } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { CliTerminalModal } from './CliTerminalModal';

function meshAgentAuthSessionForView(
  sessionId: string,
  session: MeshAgentAuthSessionView | undefined
): MeshAgentAuthSessionView | undefined {
  return session?.id === sessionId ? session : undefined;
}

export function MeshAgentAuthModal({
  sessionId,
  controlToken,
  agentName,
  onAuthenticated,
  onClose
}: {
  sessionId: string;
  controlToken: string;
  agentName: string;
  onAuthenticated?: () => void | Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const { data } = useGetMeshAgentAuthQuery({ id: sessionId, controlToken });
  const [heartbeatAuth] = useHeartbeatMeshAgentAuthMutation();
  const [inputAuth] = useInputMeshAgentAuthMutation();
  const [stopAuth] = useStopMeshAgentAuthMutation();
  const [authPersistenceError, setAuthPersistenceError] = useState<string | null>(null);
  const session = meshAgentAuthSessionForView(sessionId, data);
  const output = session?.outputSnapshot ?? '';
  const visibleOutput = authPersistenceError ? `${output}\n\n${authPersistenceError}` : output;
  const isLive = session ? session.state === 'starting' || session.state === 'running' : true;
  const status = session?.state === 'failed' ? 'error' : isLive ? 'running' : 'ok';
  const persistedAuthenticated = useRef(false);
  const persistingAuthenticated = useRef(false);

  useEffect(() => {
    if (!isLive) return;
    void heartbeatAuth({ id: sessionId, controlToken })
      .unwrap()
      .catch(() => {});
    const timer = window.setInterval(() => {
      void heartbeatAuth({ id: sessionId, controlToken })
        .unwrap()
        .catch(() => {});
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [controlToken, heartbeatAuth, isLive, sessionId]);

  useEffect(() => {
    if (session?.authState !== 'authenticated' || persistedAuthenticated.current || persistingAuthenticated.current)
      return;
    persistingAuthenticated.current = true;
    void (async () => {
      try {
        setAuthPersistenceError(null);
        await onAuthenticated?.();
        persistedAuthenticated.current = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setAuthPersistenceError(`Monad failed to save connection: ${message}`);
        persistedAuthenticated.current = false;
      } finally {
        persistingAuthenticated.current = false;
      }
    })();
  }, [onAuthenticated, session?.authState]);

  return (
    <CliTerminalModal
      eyebrow={t('web.meshAgent.connectTitle')}
      footerLabel={t('web.meshAgent.connectTerminalHint')}
      icon={isProductIconId(session?.productIcon) ? session.productIcon : undefined}
      id={sessionId}
      onClose={onClose}
      onInput={(input) => {
        if (isLive) void inputAuth({ id: sessionId, controlToken, input }).unwrap();
      }}
      onStop={() => {
        void stopAuth({ id: sessionId, controlToken }).unwrap();
        onClose();
      }}
      output={visibleOutput}
      status={status}
      stopLabel={t('web.meshAgent.stopConnect')}
      subtitle={t('web.meshAgent.connectHint')}
      tag={t('web.meshAgent.providerOwned')}
      title={agentName}
    />
  );
}
