import { useCallback, useState } from 'react';

import { SIDEBAR_SECONDARY_TEXT_CLASS } from './nav-item';

const SESSION_PREVIEW_LIMIT = 5;

const moreLessButtonClass = `w-fit px-2 py-1 text-left font-normal ${SIDEBAR_SECONDARY_TEXT_CLASS} text-xs leading-control transition focus-visible:text-muted-foreground focus-visible:outline-none`;

export function getPreviewLessTargetCount<T extends { id: string }>(
  items: readonly T[],
  activeId: string | null,
  limit = SESSION_PREVIEW_LIMIT
) {
  const activeIndex = activeId ? items.findIndex((item) => item.id === activeId) : -1;
  return activeIndex >= 0 ? Math.max(limit, activeIndex + 1) : limit;
}

export function useSidebarPreviewCount(limit = SESSION_PREVIEW_LIMIT) {
  const [visibleCount, setVisibleCount] = useState(limit);
  const showMore = useCallback(() => {
    setVisibleCount((count) => count + limit);
  }, [limit]);
  const showLess = useCallback(
    (minimumVisibleCount = limit) => {
      setVisibleCount(Math.max(limit, minimumVisibleCount));
    },
    [limit]
  );
  return { showLess, showMore, visibleCount };
}

export function useSidebarPreviewCountByKey(limit = SESSION_PREVIEW_LIMIT) {
  const [visibleCountByKey, setVisibleCountByKey] = useState<Record<string, number>>({});
  const visibleCountFor = useCallback((key: string) => visibleCountByKey[key] ?? limit, [limit, visibleCountByKey]);
  const showMore = useCallback(
    (key: string) => {
      setVisibleCountByKey((current) => ({
        ...current,
        [key]: (current[key] ?? limit) + limit
      }));
    },
    [limit]
  );
  const showLess = useCallback(
    (key: string, minimumVisibleCount = limit) => {
      const nextVisibleCount = Math.max(limit, minimumVisibleCount);
      setVisibleCountByKey((current) => {
        if (nextVisibleCount === limit) {
          const next = { ...current };
          delete next[key];
          return next;
        }
        return { ...current, [key]: nextVisibleCount };
      });
    },
    [limit]
  );
  return { showLess, showMore, visibleCountFor };
}

export function SidebarMoreLessControls({
  canShowLess,
  canShowMore,
  lessLabel,
  moreLabel,
  onShowLess,
  onShowMore
}: {
  canShowLess: boolean;
  canShowMore: boolean;
  lessLabel: string;
  moreLabel: string;
  onShowLess: () => void;
  onShowMore: () => void;
}) {
  if (!canShowMore && !canShowLess) return null;
  return (
    <div className="flex items-center gap-2">
      {canShowMore ? (
        <button
          className={moreLessButtonClass}
          onClick={onShowMore}
          type="button"
        >
          {moreLabel}
        </button>
      ) : null}
      {canShowLess ? (
        <button
          className={moreLessButtonClass}
          onClick={onShowLess}
          type="button"
        >
          {lessLabel}
        </button>
      ) : null}
    </div>
  );
}
