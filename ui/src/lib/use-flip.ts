import { useLayoutEffect, useRef, type RefObject } from "react";

/** Reordered children glide from their previous position (FLIP). */
export function useFlip(
  container: RefObject<HTMLElement | null>,
  order: string,
): void {
  const positions = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const next = new Map<string, number>();
    for (const element of root.querySelectorAll<HTMLElement>("[data-flip]")) {
      const key = element.dataset.flip!;
      const top = element.offsetTop;
      next.set(key, top);
      const previous = positions.current.get(key);
      if (reduce || previous === undefined || previous === top) continue;
      element.animate(
        [
          { transform: `translateY(${previous - top}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    }
    positions.current = next;
  }, [container, order]);
}
