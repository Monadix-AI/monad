import { PencilEdit01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Badge, Button, Switch } from '@monad/ui';

import { useT } from '#/components/I18nProvider';

export function CapabilityCard({
  available = true,
  checked,
  detail,
  labels,
  name,
  onCheckedChange,
  onEdit,
  showSwitch
}: {
  available?: boolean;
  checked: boolean;
  detail?: string;
  labels: string[];
  name: string;
  onCheckedChange: (checked: boolean) => void;
  onEdit?: () => void;
  showSwitch: boolean;
}) {
  const t = useT();
  return (
    <article className="flex min-h-16 items-start gap-3 rounded-xl border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h3 className="truncate font-medium text-sm">{name}</h3>
          {labels.map((label) => (
            <Badge
              className="h-5 px-1.5 text-[10px]"
              key={label}
              variant="secondary"
            >
              {label}
            </Badge>
          ))}
          {!available ? (
            <Badge
              className="h-5 px-1.5 text-[10px]"
              variant="outline"
            >
              {t('web.studio.agentEditor.capabilityUnavailable')}
            </Badge>
          ) : null}
        </div>
        {detail ? <p className="mt-1 line-clamp-2 text-muted-foreground text-xs">{detail}</p> : null}
      </div>
      {onEdit ? (
        <Button
          aria-label={t('web.skills.edit')}
          className="size-8 shrink-0"
          onClick={onEdit}
          size="icon"
          variant="ghost"
        >
          <HugeiconsIcon icon={PencilEdit01Icon} />
        </Button>
      ) : null}
      {showSwitch ? (
        <Switch
          aria-label={t('web.studio.agentEditor.capabilityToggle', { name })}
          checked={checked}
          className="mt-0.5"
          disabled={!available}
          onCheckedChange={onCheckedChange}
        />
      ) : null}
    </article>
  );
}
