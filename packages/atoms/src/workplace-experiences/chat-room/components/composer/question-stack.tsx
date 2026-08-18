import type { WorkplaceExperienceAgentIdentityResolver } from '@monad/sdk-experience';
import type { Participant, QuestionView } from '../../../experience/types.ts';

import { ComposerAskSheet } from '@monad/ui';
import { AgentAvatar, AgentIdentity } from '@monad/ui/components/AgentAvatar';

import { AgentProviderBadge } from '../../../components/agent-provider-badge.tsx';
import { workplaceExperienceT } from '../../../i18n.ts';
import { buildClarifyAnswer } from '../../utils/clarify-answer.ts';

export function QuestionStack({
  asker,
  onAnswer,
  onDismiss,
  position,
  question,
  resolveAgentIdentity,
  total
}: {
  asker?: Pick<Participant, 'av' | 'avatarUrl' | 'icon' | 'name'>;
  onAnswer: (requestId: string, answer: string) => void;
  onDismiss: (requestId: string) => void;
  position: number;
  question: QuestionView;
  resolveAgentIdentity?: WorkplaceExperienceAgentIdentityResolver;
  total: number;
}): React.ReactElement {
  const t = workplaceExperienceT();
  const fallbackAgent: Pick<Participant, 'av' | 'avatarUrl' | 'name'> = asker ?? {
    av: question.askerName.slice(0, 2).toUpperCase(),
    name: question.askerName
  };
  const identity = resolveAgentIdentity?.({ name: fallbackAgent.name });
  const displayAgent = {
    ...fallbackAgent,
    av: identity?.av ?? fallbackAgent.av,
    avatarUrl: identity?.avatarUrl ?? fallbackAgent.avatarUrl,
    name: identity?.name ?? fallbackAgent.name
  };

  return (
    <ComposerAskSheet
      askedLabel={t('web.workplace.askedQuestion')}
      asker={
        <>
          <AgentAvatar
            agent={displayAgent}
            size={24}
          />
          <AgentIdentity
            badge={identity?.providerIcon ? <AgentProviderBadge icon={identity.providerIcon} /> : undefined}
            badgeGap={6}
            name={displayAgent.name}
            nameStyle={{ fontSize: 13, fontWeight: 700 }}
          />
        </>
      }
      backLabel={t('web.common.back')}
      buildAnswer={buildClarifyAnswer}
      dismissLabel={t('web.inbox.skip')}
      key={question.id}
      nextLabel={t('web.common.next')}
      onAnswer={onAnswer}
      onDismiss={onDismiss}
      otherAriaLabel={t('web.workplace.otherAnswer')}
      otherPlaceholder={t('web.workplace.otherPlaceholder')}
      position={position}
      question={question}
      questions={question.questions}
      submitLabel={t('web.common.submit')}
      total={total}
    />
  );
}
