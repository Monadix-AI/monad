import { MonadLoading } from './MonadLoading';

export function PanelLoading() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <MonadLoading
        className="min-h-40 flex-1"
        markClassName="size-10"
      />
    </div>
  );
}
