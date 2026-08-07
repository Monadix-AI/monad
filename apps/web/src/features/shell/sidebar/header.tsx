const SHELL_HEADER_HEIGHT = 48;

export function SidebarHeader(_props: {
  collapsed: boolean;
  onOpenWorkspace: () => void;
  onToggleCollapsed: () => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center px-3"
      style={{ height: SHELL_HEADER_HEIGHT }}
    />
  );
}
