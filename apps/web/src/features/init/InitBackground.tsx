export function InitBackground() {
  return (
    <div
      aria-hidden
      className="fixed inset-0 -z-10 overflow-hidden bg-background"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,color-mix(in_srgb,var(--accent-blue)_28%,transparent),transparent_24%),radial-gradient(circle_at_18%_80%,color-mix(in_srgb,white_8%,transparent),transparent_24%),linear-gradient(180deg,#0a0a0a_0%,#111111_52%,#0a0a0a_100%)] dark:opacity-100" />
      <div className="absolute inset-0 bg-[linear-gradient(color-mix(in_srgb,var(--border)_28%,transparent)_1px,transparent_1px),linear-gradient(90deg,color-mix(in_srgb,var(--border)_28%,transparent)_1px,transparent_1px)] bg-[size:32px_32px] opacity-20" />
      <div className="absolute inset-x-0 top-0 h-48 bg-[radial-gradient(circle_at_top,rgba(77,184,255,0.2),transparent_70%)] blur-3xl" />
      <div className="absolute inset-x-0 bottom-0 h-40 bg-[linear-gradient(180deg,transparent,rgba(0,0,0,0.45))]" />
    </div>
  );
}
