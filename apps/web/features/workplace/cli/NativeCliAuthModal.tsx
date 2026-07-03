'use client';

import type { NativeCliAuthSessionView } from '@monad/protocol';

import {
  useGetNativeCliAuthQuery,
  useHeartbeatNativeCliAuthMutation,
  useInputNativeCliAuthMutation,
  useStopNativeCliAuthMutation
} from '@monad/client-rtk';
import { useEffect } from 'react';

import { useT } from '@/components/I18nProvider';
import { CliTerminalModal } from './CliTerminalModal';

export function nativeCliAuthSessionForView(
  sessionId: string,
  session: NativeCliAuthSessionView | undefined
): NativeCliAuthSessionView | undefined {
  return session?.id === sessionId ? session : undefined;
}

export function NativeCliAuthModal({
  sessionId,
  controlToken,
  agentName,
  onClose
}: {
  sessionId: string;
  controlToken: string;
  agentName: string;
  onClose: () => void;
}): React.ReactElement {
  const t = useT();
  const { data } = useGetNativeCliAuthQuery({ id: sessionId, controlToken });
  const [heartbeatAuth] = useHeartbeatNativeCliAuthMutation();
  const [inputAuth] = useInputNativeCliAuthMutation();
  const [stopAuth] = useStopNativeCliAuthMutation();
  const session = nativeCliAuthSessionForView(sessionId, data);
  const output = session?.outputSnapshot ?? '';
  const isLive = session ? session.state === 'starting' || session.state === 'running' : true;
  const status = session?.state === 'failed' ? 'error' : isLive ? 'running' : 'ok';

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

  return (
    <CliTerminalModal
      eyebrow={t('web.nativeCli.connectTitle')}
      footerLabel={t('web.nativeCli.connectTerminalHint')}
      icon={session?.productIcon}
      id={sessionId}
      onClose={onClose}
      onInput={(input) => {
        if (isLive) void inputAuth({ id: sessionId, controlToken, input }).unwrap();
      }}
      onStop={() => {
        void stopAuth({ id: sessionId, controlToken }).unwrap();
        onClose();
      }}
      output={output}
      status={status}
      stopLabel={t('web.nativeCli.stopConnect')}
      subtitle={t('web.nativeCli.connectHint')}
      tag={t('web.nativeCli.providerOwned')}
      title={agentName}
    />
  );
}
