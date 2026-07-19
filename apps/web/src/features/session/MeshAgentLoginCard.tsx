import type { MeshAgentLoginViewItem } from './chat-view-items';

import { useStartMeshAgentAuthMutation } from '@monad/client-rtk';
import { Button } from '@monad/ui';
import { useState } from 'react';

import { useT } from '#/components/I18nProvider';
import { MeshAgentAuthModal } from '#/features/workplace/cli/MeshAgentAuthModal';

export function MeshAgentLoginCardView({
  error,
  isLoading,
  item,
  onLogin
}: {
  error?: string | null;
  isLoading: boolean;
  item: MeshAgentLoginViewItem;
  onLogin: () => void;
}) {
  const t = useT();
  return (
    <div className="rounded-md border border-amber-500/35 bg-amber-500/10 p-3 text-xs">
      <div className="font-medium text-foreground">
        {t('web.meshAgent.signInRequiredTitle', { agentName: item.agentName })}
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
          {t('web.meshAgent.signInRequiredAction')}
        </Button>
      </div>
    </div>
  );
}

export function MeshAgentLoginCard({ item }: { item: MeshAgentLoginViewItem }) {
  const [startAuth, { isLoading }] = useStartMeshAgentAuthMutation();
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
      <MeshAgentLoginCardView
        error={startError}
        isLoading={isLoading}
        item={item}
        onLogin={() => void onLogin()}
      />
      {authSession ? (
        <MeshAgentAuthModal
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
