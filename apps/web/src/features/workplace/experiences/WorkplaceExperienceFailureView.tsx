import type { WorkplaceExperienceFailure } from './failure';

import { Button } from '@monad/ui';

import { useT } from '#/components/I18nProvider';
import { WORKPLACE_EXPERIENCE_FAILURES } from './failure';

export function WorkplaceExperienceFailureView({
  failure,
  onRetry
}: {
  failure: WorkplaceExperienceFailure;
  onRetry?: () => void;
}): React.ReactElement {
  const t = useT();
  const { message, retryable } = WORKPLACE_EXPERIENCE_FAILURES[failure.category];
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-foreground text-sm">{t(message)}</p>
      <p className="text-muted-foreground text-xs">{t('web.workplace.experienceFailure.switchHint')}</p>
      {onRetry && retryable ? (
        <Button
          onClick={onRetry}
          size="sm"
          variant="outline"
        >
          {t('web.workplace.experienceFailure.retry')}
        </Button>
      ) : null}
      {failure.detail ? (
        <details className="monad-selectable mt-1 max-w-full text-left">
          <summary className="text-muted-foreground text-xs">{t('web.workplace.experienceFailure.details')}</summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-muted-foreground text-xs">
            {failure.detail}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
