import type { ReactNode } from 'react';

// One labelled block inside the Capabilities panel (Tools, MCP, …). A sticky sub-header keeps the
// section title + its actions visible while the body scrolls under the shared panel ScrollArea.
export function CapabilitySection({
  title,
  subtitle,
  actions,
  children
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-background/95 px-5 py-3 backdrop-blur-sm">
        <div className="min-w-0">
          <p className="font-semibold text-sm">{title}</p>
          {subtitle && <p className="mt-0.5 truncate text-muted-foreground text-xs">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}
