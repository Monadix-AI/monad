'use client';

import type { ExternalAgentAuthSessionView } from '@monad/protocol';

import {
  useGetExternalAgentAuthQuery,
  useHeartbeatExternalAgentAuthMutation,
  useInputExternalAgentAuthMutation,
  useStopExternalAgentAuthMutation
} from '@monad/client-rtk';
import { isProductIconId } from '@monad/ui';
import { useEffect, useRef, useState } from 'react';

import { useT } from '@/components/I18nProvider';
import { CliTerminalModal } from './CliTerminalModal';

function externalAgentAuthSessionForView(
  sessionId: string,
  session: ExternalAgentAuthSessionView | undefined
): ExternalAgentAuthSessionView | undefined {
  return session?.id === sessionId ? session : undefined;
}

export function ExternalAgentAuthModal({
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
  const { data } = useGetExternalAgentAuthQuery({ id: sessionId, controlToken });
  const [heartbeatAuth] = useHeartbeatExternalAgentAuthMutation();
  const [inputAuth] = useInputExternalAgentAuthMutation();
  const [stopAuth] = useStopExternalAgentAuthMutation();
  const [authPersistenceError, setAuthPersistenceError] = useState<string | null>(null);
  const session = externalAgentAuthSessionForView(sessionId, data);
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
      eyebrow={t('web.externalAgent.connectTitle')}
      footerLabel={t('web.externalAgent.connectTerminalHint')}
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
      stopLabel={t('web.externalAgent.stopConnect')}
      subtitle={t('web.externalAgent.connectHint')}
      tag={t('web.externalAgent.providerOwned')}
      title={agentName}
    />
  );
}
