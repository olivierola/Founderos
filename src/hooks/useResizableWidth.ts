import { useCallback, useState } from "react";

/**
 * Drag-to-resize width for a side panel, persisted in localStorage. Same
 * recipe as `AssistantPanel.tsx`'s resize handle (drag the left edge).
 */
export function useResizableWidth(storageKey: string, defaultW: number, minW: number, maxW: number) {
  const [width, setWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(storageKey));
    return saved >= minW && saved <= maxW ? saved : defaultW;
  });

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(maxW, Math.max(minW, startW + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = "";
      setWidth((w) => { localStorage.setItem(storageKey, String(w)); return w; });
    };
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, storageKey, minW, maxW]);

  return { width, startResize };
}
