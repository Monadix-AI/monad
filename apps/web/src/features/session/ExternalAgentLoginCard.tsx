import type { ExternalAgentLoginViewItem } from './chat-view-items';

import { useStartExternalAgentAuthMutation } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ExternalAgentAuthModal } from '#/features/workplace/cli/ExternalAgentAuthModal';

export function ExternalAgentLoginCardView({
  error,
  isLoading,
  item,
  onLogin
}: {
  error?: string | null;
  isLoading: boolean;
  item: ExternalAgentLoginViewItem;
  onLogin: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
      <div className="font-medium text-foreground">
        {t('web.externalAgent.signInRequiredTitle', { agentName: item.agentName })}
      </div>
      <div className="mt-1 text-muted-foreground">{item.reason}</div>
      {error ? <div className="mt-1 text-destructive">{error}</div> : null}
      <div className="mt-2">
        <Button
          disabled={isLoading}
          onClick={onLogin}
          size="sm"
          variant="outline"
        >
          {t('web.externalAgent.signInRequiredAction')}
        </Button>
      </div>
    </div>
  );
}

export function ExternalAgentLoginCard({ item }: { item: ExternalAgentLoginViewItem }) {
  const [startAuth, { isLoading }] = useStartExternalAgentAuthMutation();
  const [authSession, setAuthSession] = useState<{ id: string; controlToken: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const onLogin = async () => {
    setStartError(null);
    try {
      const session = await startAuth(item.agentName).unwrap();
      setAuthSession({ id: session.id, controlToken: session.controlToken });
    } catch (error) {
      setStartError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <ExternalAgentLoginCardView
        error={startError}
        isLoading={isLoading}
        item={item}
        onLogin={() => void onLogin()}
      />
      {authSession ? (
        <ExternalAgentAuthModal
          agentName={item.agentName}
          controlToken={authSession.controlToken}
          onAuthenticated={() => setAuthSession(null)}
          onClose={() => setAuthSession(null)}
          sessionId={authSession.id}
        />
      ) : null}
    </>
  );
}
