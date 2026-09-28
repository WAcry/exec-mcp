/** Runs a loader at most once per delay and never twice concurrently. */
export function coalesced(run: () => Promise<void>, delay: number) {
  let timer: number | undefined;
  let running = false;
  let again = false;
  let disposed = false;
  const fire = async () => {
    timer = undefined;
    if (disposed) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await run();
    } catch {
      /* The next event or poll retries. */
    } finally {
      running = false;
      if (again && !disposed) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (timer === undefined && !disposed)
      timer = window.setTimeout(() => void fire(), delay);
  };
  return {
    schedule,
    now: () => void fire(),
    dispose: () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    },
  };
}
