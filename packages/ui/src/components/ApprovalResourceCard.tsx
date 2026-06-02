export interface ApprovalResourceCardProps {
  defaultScope?: string;
  defaultScopeLabel: string;
  operation?: string;
  resourceLabel: string;
  subject?: string;
}

export function ApprovalResourceCard({
  defaultScope,
  defaultScopeLabel,
  operation,
  resourceLabel,
  subject
}: ApprovalResourceCardProps) {
  return (
    <div className="rounded-md border border-warning/35 bg-warning/10 p-3 text-xs">
      <div className="font-medium text-foreground">
        {resourceLabel}
        {operation ? <span className="text-muted-foreground"> · {operation}</span> : null}
      </div>
      {subject ? <div className="mt-1 break-all font-mono text-muted-foreground">{subject}</div> : null}
      {defaultScope ? (
        <div className="mt-2 text-muted-foreground">
          {defaultScopeLabel}: {defaultScope}
        </div>
      ) : null}
    </div>
  );
}
