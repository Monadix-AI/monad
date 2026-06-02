import { TimelineDivider } from '@monad/ui';

export function ContextCompactionCard({ text }: { text: string }): React.ReactElement {
  return (
    <TimelineDivider className="px-1">
      <span
        className="font-medium text-muted-foreground text-xs"
        data-observation-context-compaction=""
      >
        {text}
      </span>
    </TimelineDivider>
  );
}
