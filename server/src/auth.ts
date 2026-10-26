import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'nf_session';
export const SESSION_MAX_AGE_S = 30 * 24 * 3600;
export const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_S * 1000;

/** Zufälliges Session-Token (32 Bytes) fürs Cookie. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** In der DB wird nur der SHA-256-Hash des Tokens gespeichert. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Timing-safe Vergleich (beide Seiten gehasht, damit Länge nichts verrät). */
export function passwordMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

interface AttemptState {
  fails: number;
  lockedUntil: number;
}

/** Brute-Force-Schutz: nach maxAttempts Fehlversuchen pro IP Sperre für lockMs. */
export class LoginGuard {
  private readonly maxAttempts: number;
  private readonly lockMs: number;
  private readonly state = new Map<string, AttemptState>();

  constructor(maxAttempts: number, lockMinutes: number) {
    this.maxAttempts = maxAttempts;
    this.lockMs = lockMinutes * 60_000;
  }

  /** Restliche Sperrzeit in ms (0 = nicht gesperrt). */
  lockedFor(ip: string, now = Date.now()): number {
    const s = this.state.get(ip);
    if (!s || s.lockedUntil === 0) return 0;
    if (s.lockedUntil <= now) {
      this.state.delete(ip);
      return 0;
    }
    return s.lockedUntil - now;
  }

  recordFailure(ip: string, now = Date.now()): void {
    const s = this.state.get(ip) ?? { fails: 0, lockedUntil: 0 };
    s.fails += 1;
    if (s.fails >= this.maxAttempts) s.lockedUntil = now + this.lockMs;
    this.state.set(ip, s);
    if (this.state.size > 10_000) this.prune(now);
  }

  recordSuccess(ip: string): void {
    this.state.delete(ip);
  }

  private prune(now: number): void {
    for (const [ip, s] of this.state) if (s.lockedUntil !== 0 && s.lockedUntil <= now) this.state.delete(ip);
  }
}
