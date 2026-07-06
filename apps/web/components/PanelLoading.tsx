import { Spinner } from '@monad/ui';

export function PanelLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}
