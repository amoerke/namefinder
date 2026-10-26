import { describe, expect, it } from 'vitest';
import { LoginGuard, hashToken, newSessionToken, passwordMatches } from './auth.ts';
import { Db } from './db.ts';

describe('Sessions', () => {
  it('Tokens sind zufällig, 32 Bytes', () => {
    const a = newSessionToken();
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(newSessionToken()).not.toBe(a);
  });
  it('werden in SQLite gespeichert, laufen ab, Logout löscht', () => {
    const db = new Db(':memory:');
    const h = hashToken(newSessionToken());
    db.createSession(h, 10_000);
    expect(db.isSessionValid(h, 5_000)).toBe(true);
    expect(db.isSessionValid(hashToken('fremd'), 5_000)).toBe(false);
    expect(db.isSessionValid(h, 10_000)).toBe(false);
    expect(db.purgeExpiredSessions(10_000)).toBe(1);
    const h2 = hashToken(newSessionToken());
    db.createSession(h2, 10_000);
    db.deleteSession(h2);
    expect(db.isSessionValid(h2, 0)).toBe(false);
    db.close();
  });
  it('Passwortvergleich', () => {
    expect(passwordMatches('abc', 'abc')).toBe(true);
    expect(passwordMatches('abcd', 'abc')).toBe(false);
  });
});

describe('LoginGuard', () => {
  it('sperrt nach max. Fehlversuchen pro IP und gibt danach frei', () => {
    const g = new LoginGuard(3, 15);
    const t = 1_000;
    g.recordFailure('1.1.1.1', t);
    g.recordFailure('1.1.1.1', t);
    expect(g.lockedFor('1.1.1.1', t)).toBe(0);
    g.recordFailure('1.1.1.1', t);
    expect(g.lockedFor('1.1.1.1', t)).toBe(15 * 60_000);
    expect(g.lockedFor('2.2.2.2', t)).toBe(0);
    expect(g.lockedFor('1.1.1.1', t + 15 * 60_000)).toBe(0);
  });
  it('Erfolg setzt Zähler zurück', () => {
    const g = new LoginGuard(2, 15);
    g.recordFailure('ip', 0);
    g.recordSuccess('ip');
    g.recordFailure('ip', 0);
    expect(g.lockedFor('ip', 0)).toBe(0);
  });
});
