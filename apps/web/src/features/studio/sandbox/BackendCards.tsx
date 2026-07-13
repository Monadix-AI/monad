import type { SandboxBackendView } from '@monad/protocol';

import { Button } from '@monad/ui';

export function backendRefKey(backend: SandboxBackendView): string {
  const { ref } = backend;
  return ref.source === 'builtin' ? `builtin/${ref.kind}` : `atom-pack/${ref.packId}/${ref.kind}`;
}

export function groupSandboxBackends(backends: SandboxBackendView[]): {
  builtin: SandboxBackendView[];
  installed: SandboxBackendView[];
} {
  return {
    builtin: backends.filter((backend) => backend.ref.source === 'builtin'),
    installed: backends.filter((backend) => backend.ref.source === 'atom-pack')
  };
}

function BackendCard({
  backend,
  selected,
  onSelect
}: {
  backend: SandboxBackendView;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <Button
      className={`h-auto items-start justify-start whitespace-normal p-3 text-left ${selected ? 'border-primary' : ''}`}
      onClick={onSelect}
      variant="outline"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center justify-between gap-3">
          <span className="font-medium text-sm">{backend.descriptor.name}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase">{backend.status}</span>
        </span>
        <span className="text-muted-foreground text-xs">{backend.sourceLabel}</span>
        {backend.descriptor.description && (
          <span className="text-muted-foreground text-xs">{backend.descriptor.description}</span>
        )}
      </span>
    </Button>
  );
}

export function BackendCards({
  backends,
  selectedKey,
  onSelect
}: {
  backends: SandboxBackendView[];
  selectedKey?: string;
  onSelect: (backend: SandboxBackendView) => void;
}) {
  const groups = groupSandboxBackends(backends);
  return (
    <div className="flex flex-col gap-4">
      {(
        [
          ['Built-in', groups.builtin],
          ['Installed', groups.installed]
        ] as const
      ).map(([label, items]) =>
        items.length ? (
          <div
            className="flex flex-col gap-2"
            key={label}
          >
            <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{label}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {items.map((backend) => (
                <BackendCard
                  backend={backend}
                  key={backendRefKey(backend)}
                  onSelect={() => onSelect(backend)}
                  selected={backendRefKey(backend) === selectedKey}
                />
              ))}
            </div>
          </div>
        ) : null
      )}
    </div>
  );
}
