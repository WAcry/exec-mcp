import { useSyncExternalStore } from "react";

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer?: number;
}

const clocks = new Map<number, Clock>();

function clock(interval: number): Clock {
  let value = clocks.get(interval);
  if (!value) {
    value = { now: Date.now(), listeners: new Set() };
    clocks.set(interval, value);
  }
  return value;
}

const subscribers = new Map<number, (listener: () => void) => () => void>();

function subscriber(interval: number) {
  let subscribe = subscribers.get(interval);
  if (!subscribe) {
    subscribe = (listener) => {
      const current = clock(interval);
      current.listeners.add(listener);
      if (current.timer === undefined) {
        current.now = Date.now();
        current.timer = window.setInterval(() => {
          current.now = Date.now();
          for (const notify of current.listeners) notify();
        }, interval);
      }
      return () => {
        current.listeners.delete(listener);
        if (!current.listeners.size && current.timer !== undefined) {
          window.clearInterval(current.timer);
          current.timer = undefined;
        }
      };
    };
    subscribers.set(interval, subscribe);
  }
  return subscribe;
}

/** One shared timer per granularity, so many relative times cost one interval. */
export function useNow(interval = 30_000): number {
  return useSyncExternalStore(subscriber(interval), () => clock(interval).now);
}
