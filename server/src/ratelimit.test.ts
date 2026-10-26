import { describe, expect, it } from 'vitest';
import { GenerationLimiter } from './ratelimit.ts';

describe('GenerationLimiter', () => {
  it('begrenzt pro Session und Stunde (sliding window)', () => {
    const l = new GenerationLimiter(2, 100);
    const t = 1_000_000;
    expect(l.reserve('a', t).ok).toBe(true);
    expect(l.reserve('a', t + 1000).ok).toBe(true);
    const r = l.reserve('a', t + 2000);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/pro Stunde/);
    expect(l.reserve('b', t + 2000).ok).toBe(true);
    expect(l.reserve('a', t + 3_600_001).ok).toBe(true);
  });

  it('globales Tageslimit über alle Sessions', () => {
    const t = 5_000_000;
    const l = new GenerationLimiter(10, 3, [t - 1000]);
    l.reserve('a', t);
    l.reserve('b', t);
    const r = l.reserve('c', t);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Tageslimit/);
    expect(l.reserve('c', t + 24 * 3_600_000).ok).toBe(true);
  });

  it('reserviert sofort (kein Rennen) und gibt bei Fehlschlag frei', () => {
    const l = new GenerationLimiter(1, 1);
    const first = l.reserve('a', 0);
    expect(first.ok).toBe(true);
    expect(l.reserve('a', 1).ok).toBe(false); // parallele Anfrage
    expect(l.reserve('b', 1).ok).toBe(false); // global belegt
    if (first.ok) {
      first.release();
      first.release(); // idempotent
    }
    expect(l.reserve('b', 2).ok).toBe(true);
  });
});
