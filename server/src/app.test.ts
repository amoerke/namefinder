import { describe, expect, it, vi } from 'vitest';
import type { DomainCheck, Search } from '../../shared/types.ts';
import { createApp } from './app.ts';
import { hashToken } from './auth.ts';
import type { Config } from './config.ts';
import { Db } from './db.ts';
import type { DomainChecker } from './domains/index.ts';
import { EventHub } from './events.ts';
import { GenerationLimiter } from './ratelimit.ts';

function setup() {
  const db = new Db(':memory:');
  db.createSession(hashToken('tok'), Date.now() + 60_000);
  const hub = new EventHub();
  const events: unknown[] = [];
  hub.subscribe((ev) => events.push(ev));
  const pending = (domain: string, tld: 'de' | 'com'): DomainCheck => ({ domain, tld, status: 'pending', checkedAt: null });
  const enqueue = vi.fn((_id: string, name: string, _parts: string[], _opts?: { force?: boolean }): DomainCheck[] => [
    pending(`${name.toLowerCase()}.de`, 'de'),
    pending(`${name.toLowerCase()}.com`, 'com'),
  ]);
  const checker: DomainChecker = { enqueue };
  const app = createApp({
    config: { appPassword: 'pw', trustProxy: false, loginMaxAttempts: 5, loginLockMinutes: 1 } as Config,
    db,
    checker,
    limiter: new GenerationLimiter(10, 10),
    hub,
    providers: { anthropic: { label: 'Claude', model: 'm', generate: async () => [{ name: 'Sonnenplan', parts: ['Sonnen', 'plan'], rationale: '' }] } },
  });
  const call = (method: string, url: string, body?: unknown) =>
    app.request(url, {
      method,
      headers: { cookie: 'nf_session=tok', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { app, db, enqueue, events, call };
}

describe('manuelle Domain-Prüfung', () => {
  it('generate und variants starten keine Prüfung', async () => {
    const { call, enqueue } = setup();
    const res = await call('POST', '/api/generate', { description: 'Solarfirma für Dächer', styles: ['kombination'] });
    expect(res.status).toBe(200);
    const search = (await res.json()) as Search;
    expect(search.suggestions.every((s) => s.checks.length === 0)).toBe(true);
    const v = await call('POST', `/api/suggestions/${search.suggestions[0]!.id}/variants`);
    expect(v.status).toBe(200);
    expect(((await v.json()) as { checks: unknown[] }[]).every((s) => s.checks.length === 0)).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('POST /check ohne force, speichert und sendet die Checks', async () => {
    const { call, enqueue, events, db } = setup();
    const search = (await (await call('POST', '/api/generate', { description: 'Solarfirma für Dächer', styles: ['kombination'] })).json()) as Search;
    const id = search.suggestions[0]!.id;
    const res = await call('POST', `/api/suggestions/${id}/check`);
    expect(res.status).toBe(200);
    const checks = (await res.json()) as DomainCheck[];
    expect(checks.map((c) => c.domain)).toEqual(['sonnenplan.de', 'sonnenplan.com']);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0]![3]?.force).toBeFalsy();
    expect(events).toHaveLength(2);
    expect(db.getSuggestion(id)!.suggestion.checks).toHaveLength(2);
  });

  it('POST /check liefert 404 für unbekannte Vorschläge', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/suggestions/nope/check')).status).toBe(404);
  });
});
