/** Frame and main-thread measurements for the flight reports. */

export interface LongTask {
  /** ms since page start */
  start: number;
  duration: number;
}

export interface FrameStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

interface PerformanceWithMemory extends Performance {
  /** Chromium only */
  memory?: { usedJSHeapSize: number };
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function summarize(frames: readonly number[]): FrameStats {
  const sorted = [...frames].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), max: sorted[sorted.length - 1] ?? 0 };
}

/** JS heap in MB where the browser exposes it (Chromium), else -1. */
export function jsHeapMB(): number {
  const mem = (performance as PerformanceWithMemory).memory;
  return mem ? mem.usedJSHeapSize / 1048576 : -1;
}

/** Collects `longtask` entries (main-thread tasks over 50 ms) for the whole page life; windows are cut by time. */
export class LongTasks {
  readonly entries: LongTask[] = [];
  readonly supported: boolean;

  constructor() {
    let ok = false;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.entries.push({ start: e.startTime, duration: e.duration });
      });
      observer.observe({ type: 'longtask', buffered: true });
      ok = true;
    } catch {
      // no Long Tasks API (Safari, Firefox): reports say so instead of claiming zero
    }
    this.supported = ok;
  }

  between(t0: number, t1: number): LongTask[] {
    return this.entries.filter((e) => e.start + e.duration >= t0 && e.start <= t1);
  }
}
