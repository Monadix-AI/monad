import type { Participant, QuestionView } from '../../../project/types.ts';

import { ComposerAskSheet, ProductIcon } from '@monad/ui';
import { AgentIdentity, AgentInstanceAvatar, resolveProductIcon } from '@monad/ui/components/AgentAvatar';

import { workspaceExperienceT } from '../../../i18n.ts';
import { buildClarifyAnswer } from '../../utils/clarify-answer.ts';

export function QuestionStack({
  asker,
  onAnswer,
  onDismiss,
  position,
  question,
  total
}: {
  asker?: Pick<Participant, 'av' | 'avatarUrl' | 'icon' | 'name'>;
  onAnswer: (requestId: string, answer: string) => void;
  onDismiss: (requestId: string) => void;
  position: number;
  question: QuestionView;
  total: number;
}): React.ReactElement {
  const t = workspaceExperienceT();
  const displayAgent = asker ?? {
    av: question.askerName.slice(0, 2).toUpperCase(),
    name: question.askerName
  };
  const productIcon = resolveProductIcon(displayAgent);

  return (
    <ComposerAskSheet
      askedLabel={t('web.workplace.askedQuestion')}
      asker={
        <>
          <AgentInstanceAvatar
            agent={displayAgent}
            size={28}
          />
          <AgentIdentity
            badge={
              productIcon ? (
                <ProductIcon
                  product={productIcon}
                  size={13}
                  title={displayAgent.name}
                />
              ) : null
            }
            badgeGap={6}
            name={displayAgent.name}
            nameStyle={{ fontSize: 14, fontWeight: 750 }}
          />
        </>
      }
      buildAnswer={buildClarifyAnswer}
      dismissLabel="Dismiss"
      onAnswer={onAnswer}
      onDismiss={onDismiss}
      otherAriaLabel={t('web.workplace.otherAnswer')}
      otherPlaceholder={t('web.workplace.otherPlaceholder')}
      position={position}
      question={question}
      submitLabel="Submit"
      total={total}
    />
  );
}
