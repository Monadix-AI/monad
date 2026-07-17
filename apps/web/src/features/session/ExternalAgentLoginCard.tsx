import type { ExternalAgentLoginViewItem } from './chat-view-items';

import { useStartExternalAgentAuthMutation } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { ExternalAgentAuthModal } from '#/features/workplace/cli/ExternalAgentAuthModal';

export function ExternalAgentLoginCard({ item }: { item: ExternalAgentLoginViewItem }) {
  const t = useT();
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
    <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
      <div className="font-medium text-foreground">
        {t('web.externalAgent.signInRequiredTitle', { agentName: item.agentName })}
      </div>
      <div className="mt-1 text-muted-foreground">{item.reason}</div>
      {startError ? <div className="mt-1 text-destructive">{startError}</div> : null}
      <div className="mt-2">
        <Button
          disabled={isLoading}
          onClick={() => void onLogin()}
          size="sm"
          variant="outline"
        >
          {t('web.externalAgent.signInRequiredAction')}
        </Button>
      </div>
      {authSession ? (
        <ExternalAgentAuthModal
          agentName={item.agentName}
          controlToken={authSession.controlToken}
          onAuthenticated={() => setAuthSession(null)}
          onClose={() => setAuthSession(null)}
          sessionId={authSession.id}
        />
      ) : null}
    </div>
  );
}
