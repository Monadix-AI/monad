import type { StatusTone } from '../client-logic.ts';

export function StatusChip({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span
      className="status"
      data-tone={tone}
    >
      {label.replaceAll('_', ' ')}
    </span>
  );
}
