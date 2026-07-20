import type { MeshAgentAuthSessionView } from '@monad/protocol';

import {
  useGetMeshAgentAuthQuery,
  useHeartbeatMeshAgentAuthMutation,
  useInputMeshAgentAuthMutation,
  useStartMeshAgentAuthMutation,
  useStopMeshAgentAuthMutation
} from '@monad/client-rtk';
import { isProductIconId } from '@monad/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { CliTerminalModal } from './CliTerminalModal';

function meshAgentAuthSessionForView(
  sessionId: string,
  session: MeshAgentAuthSessionView | undefined
): MeshAgentAuthSessionView | undefined {
  return session?.id === sessionId ? session : undefined;
}

function authSessionMissing(error: unknown): boolean {
  const text = error instanceof Error ? error.message : JSON.stringify(error);
  return text.includes('404') || text.includes('not found');
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
  const [activeAuthSession, setActiveAuthSession] = useState({ id: sessionId, controlToken });
  const { data, error: getAuthError } = useGetMeshAgentAuthQuery(activeAuthSession);
  const [startAuth] = useStartMeshAgentAuthMutation();
  const [heartbeatAuth] = useHeartbeatMeshAgentAuthMutation();
  const [inputAuth] = useInputMeshAgentAuthMutation();
  const [stopAuth] = useStopMeshAgentAuthMutation();
  const [authPersistenceError, setAuthPersistenceError] = useState<string | null>(null);
  const restartingAuth = useRef(false);
  const session = meshAgentAuthSessionForView(activeAuthSession.id, data);
  const output = session?.outputSnapshot ?? '';
  const visibleOutput = authPersistenceError ? `${output}\n\n${authPersistenceError}` : output;
  const isLive = session ? session.state === 'starting' || session.state === 'running' : true;
  const status = session?.state === 'failed' ? 'error' : isLive ? 'running' : 'ok';
  const persistedAuthenticated = useRef(false);
  const persistingAuthenticated = useRef(false);

  useEffect(() => {
    setActiveAuthSession({ id: sessionId, controlToken });
  }, [controlToken, sessionId]);

  const restartMissingAuthSession = useCallback(async () => {
    if (restartingAuth.current) return;
    restartingAuth.current = true;
    try {
      const next = await startAuth(agentName).unwrap();
      setAuthPersistenceError(null);
      setActiveAuthSession({ id: next.id, controlToken: next.controlToken });
    } finally {
      restartingAuth.current = false;
    }
  }, [agentName, startAuth]);

  useEffect(() => {
    if (getAuthError && authSessionMissing(getAuthError)) void restartMissingAuthSession();
  }, [getAuthError, restartMissingAuthSession]);

  useEffect(() => {
    if (!isLive) return;
    void heartbeatAuth(activeAuthSession)
      .unwrap()
      .catch((error) => {
        if (authSessionMissing(error)) void restartMissingAuthSession();
      });
    const timer = window.setInterval(() => {
      void heartbeatAuth(activeAuthSession)
        .unwrap()
        .catch((error) => {
          if (authSessionMissing(error)) void restartMissingAuthSession();
        });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [activeAuthSession, heartbeatAuth, isLive, restartMissingAuthSession]);

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
      id={activeAuthSession.id}
      onClose={onClose}
      onInput={(input) => {
        if (isLive)
          void inputAuth({ ...activeAuthSession, input })
            .unwrap()
            .catch((error) => {
              if (authSessionMissing(error)) void restartMissingAuthSession();
            });
      }}
      onStop={() => {
        void stopAuth(activeAuthSession).unwrap();
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
