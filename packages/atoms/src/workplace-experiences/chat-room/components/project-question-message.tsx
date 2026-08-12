import type { UIQuestionPresentation } from '@monad/protocol';

import { EditorialQuestion } from '@monad/ui';

export function ProjectQuestionMessage({
  pending,
  presentation,
  waitingLabel
}: {
  pending: boolean;
  presentation: UIQuestionPresentation;
  waitingLabel?: string;
}): React.ReactElement {
  return (
    <div>
      <EditorialQuestion
        answer={presentation.answer}
        options={presentation.options}
        question={presentation.question}
      />
      {pending && waitingLabel ? (
        <p className="mt-3 mb-0 font-ui text-[12px] text-muted-foreground leading-5">{waitingLabel}</p>
      ) : null}
    </div>
  );
}
