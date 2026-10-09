import { describe, it, expect } from 'vitest';
import { SnapshotCache } from '../server/snapshot-cache';

describe('snapshot cache', () => {
  it('shares one load across concurrent readers', async () => {
    const c = new SnapshotCache<number>(1000);
    let loads = 0;
    const load = async () => (loads++, await new Promise((r) => setTimeout(r, 20)), 1);
    await Promise.all(Array.from({ length: 50 }, () => c.get('p', load)));
    expect(loads).toBe(1);
  });
  it('never stores a load that raced an invalidation', async () => {
    const c = new SnapshotCache<string>(1000);
    let release!: () => void;
    const slow = c.get('p', () => new Promise((r) => (release = () => r('stale'))));
    c.invalidate('p');
    release();
    expect(await slow).toBe('stale');
    expect(await c.get('p', async () => 'fresh')).toBe('fresh');
  });
  it('is disabled with a zero TTL', async () => {
    const c = new SnapshotCache<number>(0);
    let loads = 0;
    await c.get('p', async () => ++loads);
    await c.get('p', async () => ++loads);
    expect(loads).toBe(2);
  });
});
