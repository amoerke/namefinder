const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Serial queue that starts at most one task per intervalMs. */
export class ThrottledQueue {
  intervalMs: number;
  private nextAt = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      const wait = this.nextAt - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt = Date.now() + this.intervalMs;
      return task();
    });
    this.chain = p.catch(() => {});
    return p;
  }
}

/**
 * Runs task through the queue; on 'unknown' retries with backoff (not blocking the queue meanwhile).
 */
export async function runWithRetry<T extends string>(
  queue: ThrottledQueue,
  task: () => Promise<T>,
  opts: { attempts?: number; backoffMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const backoff = opts.backoffMs ?? 5000;
  let result = await queue.run(task);
  for (let i = 1; i < attempts && result === "unknown"; i++) {
    await sleep(backoff * 2 ** (i - 1));
    result = await queue.run(task);
  }
  return result;
}
