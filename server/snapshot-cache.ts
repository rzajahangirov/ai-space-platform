// Short-lived per-instance cache of project snapshots. Under a burst of identical reads, one database
// round of 14 queries serves every request for up to SNAPSHOT_CACHE_MS (default 1000 ms; 0 disables).
// Correctness rules:
// - authorization is never cached: each request checks membership before receiving the body;
// - every committed change invalidates the project (locally and, through Redis, on every instance);
// - a load that started before an invalidation is not stored (generation check), so a write is never
//   hidden by a snapshot read concurrently with it;
// - concurrent misses share one in-flight load (single flight).
export class SnapshotCache<T> {
  private entries = new Map<string, { value: T; expires: number }>();
  private inflight = new Map<string, { gen: number; promise: Promise<T> }>();
  private generation = new Map<string, number>();
  hits = 0;
  misses = 0;
  constructor(private ttlMs: number) {}

  invalidate(key: string) {
    this.generation.set(key, (this.generation.get(key) ?? 0) + 1);
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  async get(key: string, load: () => Promise<T>): Promise<T> {
    if (this.ttlMs <= 0) return load();
    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > now) {
      this.hits++;
      return hit.value;
    }
    const gen = this.generation.get(key) ?? 0;
    const running = this.inflight.get(key);
    if (running && running.gen === gen) {
      this.hits++;
      return running.promise;
    }
    this.misses++;
    const promise = load();
    this.inflight.set(key, { gen, promise });
    try {
      const value = await promise;
      if ((this.generation.get(key) ?? 0) === gen) {
        this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
        if (this.entries.size > 500) this.entries.delete(this.entries.keys().next().value!);
      }
      return value;
    } finally {
      if (this.inflight.get(key)?.promise === promise) this.inflight.delete(key);
    }
  }
}
