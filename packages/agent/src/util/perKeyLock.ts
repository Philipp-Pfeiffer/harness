/**
 * Serializes async work per key. Concurrent callers for the same key
 * share the in-flight promise instead of running duplicate work.
 */
export class PerKeyLock {
  private readonly inflight = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }
}
