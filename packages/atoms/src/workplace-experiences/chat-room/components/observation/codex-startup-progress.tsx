import { ObservationText } from '@monad/ui';

export type CodexMcpStartupUpdate = {
  name: string;
  status: string;
  error?: string;
};

function codexMcpStartupText(update: CodexMcpStartupUpdate): string {
  const text = `MCP Server ${update.name} ${update.status}`;
  return update.error ? `${text}: ${update.error}` : text;
}

export function CodexMcpStartupProgressCard({
  updates
}: {
  updates: readonly CodexMcpStartupUpdate[];
}): React.ReactElement {
  return (
    <div className="grid gap-1.5">
      {updates.map((update) => (
        <ObservationText
          contained
          key={update.name}
          observationRole="system"
          text={codexMcpStartupText(update)}
        />
      ))}
    </div>
  );
}
