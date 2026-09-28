import { useEffect, useState } from "react";

/** Keeps collapsing content mounted until its height transition has finished. */
export function useLazyMount(open: boolean, delay = 260): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), delay);
    return () => window.clearTimeout(timer);
  }, [open, delay]);
  return open || mounted;
}
