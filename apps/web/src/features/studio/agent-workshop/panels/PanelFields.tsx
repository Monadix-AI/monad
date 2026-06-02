import { SwitchSetting } from '#/components/ui/switch-setting';

export function FieldError({ children }: { children?: string }) {
  return children ? (
    <p
      aria-live="polite"
      className="text-destructive text-xs"
    >
      {children}
    </p>
  ) : null;
}

export function ToggleRow({
  checked,
  hint,
  label,
  onCheckedChange
}: {
  checked: boolean;
  hint: string;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <SwitchSetting
      checked={checked}
      className="min-h-14 border-b py-3 last:border-b-0"
      description={hint}
      onCheckedChange={onCheckedChange}
      title={label}
    />
  );
}
