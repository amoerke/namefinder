import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { getConnInfo } from '@hono/node-server/conninfo';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { NameSuggestion, Provider, ProviderInfo, Search } from '../../shared/types.ts';
import type { Config } from './config.ts';
import type { Db } from './db.ts';
import type { DomainChecker } from './domains/index.ts';
import { generateVariants } from './domains/index.ts';
import { LoginGuard, SESSION_COOKIE, SESSION_MAX_AGE_MS, SESSION_MAX_AGE_S, hashToken, newSessionToken, passwordMatches } from './auth.ts';
import type { GenerationLimiter } from './ratelimit.ts';
import type { EventHub } from './events.ts';
import { GenerateRequestSchema, GenerationError, type NameGenerator } from './generate.ts';

export interface AppDeps {
  config: Config;
  db: Db;
  checker: DomainChecker;
  limiter: GenerationLimiter;
  hub: EventHub;
  /** Nur Anbieter mit gesetztem API-Key; Reihenfolge = Voreinstellung in der UI. */
  providers: Partial<Record<Provider, { label: string; model: string; generate: NameGenerator }>>;
  loginGuard?: LoginGuard;
}

type Env = { Variables: { sid: string } };

export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    // Caddy hängt die echte Client-IP hinten an; der linke Teil wäre fälschbar.
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function isHttps(c: Context, trustProxy: boolean): boolean {
  if (trustProxy && c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') return true;
  return new URL(c.req.url).protocol === 'https:';
}

const FavoritePatch = z.object({ note: z.string().max(2000).optional(), rating: z.number().int().min(0).max(5).optional() });

export function createApp(deps: AppDeps): Hono<Env> {
  const { config, db, checker, limiter, hub, providers } = deps;
  const providerIds = Object.keys(providers) as Provider[];
  const guard = deps.loginGuard ?? new LoginGuard(config.loginMaxAttempts, config.loginLockMinutes);
  const app = new Hono<Env>();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'Interner Serverfehler.' }, 500);
  });

  // --- Auth ---
  app.post('/api/login', async (c) => {
    const ip = clientIp(c, config.trustProxy);
    const locked = guard.lockedFor(ip);
    if (locked > 0) {
      c.header('Retry-After', String(Math.ceil(locked / 1000)));
      return c.json({ error: `Zu viele Fehlversuche. Bitte in ${Math.ceil(locked / 60_000)} Minute(n) erneut versuchen.` }, 429);
    }
    const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
    const pw = typeof body?.password === 'string' ? body.password : '';
    if (!passwordMatches(pw, config.appPassword)) {
      guard.recordFailure(ip);
      return c.json({ error: 'Falsches Passwort.' }, 401);
    }
    guard.recordSuccess(ip);
    const token = newSessionToken();
    db.createSession(hashToken(token), Date.now() + SESSION_MAX_AGE_MS);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isHttps(c, config.trustProxy),
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
    });
    return c.body(null, 204);
  });

  app.post('/api/logout', (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) db.deleteSession(hashToken(token));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  const sessionId = (c: Context): string | null => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const hash = hashToken(token);
    return db.isSessionValid(hash) ? hash : null;
  };

  app.get('/api/session', (c) => c.json({ authenticated: sessionId(c) !== null }));

  app.use('/api/*', async (c, next) => {
    const sid = sessionId(c);
    if (!sid) return c.json({ error: 'Nicht angemeldet.' }, 401);
    c.set('sid', sid);
    await next();
  });

  // --- Generierung ---
  app.get('/api/providers', (c) =>
    c.json(providerIds.map((id): ProviderInfo => ({ id, label: providers[id]!.label, model: providers[id]!.model }))),
  );

  app.post('/api/generate', async (c) => {
    const parsed = GenerateRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? 'Ungültige Eingabe.' }, 400);
    const providerId = parsed.data.provider ?? providerIds[0];
    const provider = providerId ? providers[providerId] : undefined;
    if (!providerId || !provider) {
      return c.json({ error: 'Dieser KI-Anbieter ist auf dem Server nicht eingerichtet (API-Key fehlt).' }, 503);
    }
    const sid = c.get('sid');
    const limit = limiter.reserve(sid);
    if (!limit.ok) {
      c.header('Retry-After', String(limit.retryAfterS));
      return c.json({ error: limit.error }, 429);
    }
    let names;
    try {
      names = await provider.generate(parsed.data);
    } catch (err) {
      // Fehlgeschlagene Generierungen zählen nicht gegen die Limits.
      limit.release();
      if (err instanceof GenerationError) return c.json({ error: err.message }, err.status as 400);
      throw err;
    }
    const search: Search = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      request: { ...parsed.data, provider: providerId },
      suggestions: names.map((n) => ({ id: randomUUID(), ...n, isVariant: false, parentId: null, checks: [] })),
    };
    db.insertSearch(search);
    return c.json(search);
  });

  app.get('/api/searches', (c) => c.json(db.listSearches(50)));

  app.get('/api/searches/:id', (c) => {
    const s = db.getSearch(c.req.param('id'));
    return s ? c.json(s) : c.json({ error: 'Suche nicht gefunden.' }, 404);
  });

  app.post('/api/suggestions/:id/variants', (c) => {
    const found = db.getSuggestion(c.req.param('id'));
    if (!found) return c.json({ error: 'Vorschlag nicht gefunden.' }, 404);
    const parent = found.suggestion;
    const search = db.getSearch(found.searchId);
    const existing = new Set((search?.suggestions ?? []).map((s) => s.name.toLowerCase()));
    const variants: NameSuggestion[] = [];
    const language = search?.request.language;
    for (const v of generateVariants(parent.name, parent.parts, language)) {
      if (existing.has(v.name.toLowerCase())) continue;
      existing.add(v.name.toLowerCase());
      variants.push({
        id: randomUUID(),
        name: v.name,
        parts: v.parts,
        rationale: `Variante von ${parent.name}`,
        isVariant: true,
        parentId: parent.id,
        checks: [],
      });
    }
    // Varianten bleiben ungeprüft (checks: []); die Prüfung startet manuell über /check.
    db.insertSuggestions(found.searchId, variants);
    return c.json(variants);
  });

  // Manueller Start: ohne force, damit der Domain-Cache genutzt wird; Antwort = sofortiger Stand.
  app.post('/api/suggestions/:id/check', (c) => {
    const found = db.getSuggestion(c.req.param('id'));
    if (!found) return c.json({ error: 'Vorschlag nicht gefunden.' }, 404);
    const s = found.suggestion;
    const checks = checker.enqueue(s.id, s.name, s.parts);
    for (const ch of checks) {
      db.applyCheck(s.id, ch);
      hub.broadcast({ suggestionId: s.id, check: ch });
    }
    return c.json(checks);
  });

  app.post('/api/suggestions/:id/recheck', (c) => {
    const found = db.getSuggestion(c.req.param('id'));
    if (!found) return c.json({ error: 'Vorschlag nicht gefunden.' }, 404);
    const s = found.suggestion;
    for (const ch of checker.enqueue(s.id, s.name, s.parts, { force: true })) {
      db.applyCheck(s.id, ch);
      hub.broadcast({ suggestionId: s.id, check: ch });
    }
    return c.body(null, 204);
  });

  // --- Favoriten ---
  app.get('/api/favorites', (c) => c.json(db.listFavorites()));

  app.post('/api/favorites', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { suggestionId?: unknown } | null;
    if (typeof body?.suggestionId !== 'string') return c.json({ error: 'suggestionId fehlt.' }, 400);
    const fav = db.addFavorite(body.suggestionId);
    return fav ? c.json(fav) : c.json({ error: 'Vorschlag nicht gefunden.' }, 404);
  });

  app.patch('/api/favorites/:id', async (c) => {
    const parsed = FavoritePatch.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Ungültige Eingabe (note: Text, rating: 0–5).' }, 400);
    const fav = db.updateFavorite(c.req.param('id'), parsed.data);
    return fav ? c.json(fav) : c.json({ error: 'Favorit nicht gefunden.' }, 404);
  });

  app.delete('/api/favorites/:id', (c) => {
    return db.deleteFavorite(c.req.param('id')) ? c.body(null, 204) : c.json({ error: 'Favorit nicht gefunden.' }, 404);
  });

  app.post('/api/favorites/:id/recheck', (c) => {
    const fav = db.getFavorite(c.req.param('id'));
    if (!fav) return c.json({ error: 'Favorit nicht gefunden.' }, 404);
    const parts = db.getSuggestion(fav.suggestionId)?.suggestion.parts ?? [fav.name];
    for (const ch of checker.enqueue(fav.suggestionId, fav.name, parts, { force: true })) {
      db.applyCheck(fav.suggestionId, ch);
      hub.broadcast({ suggestionId: fav.suggestionId, check: ch });
    }
    return c.json(db.getFavorite(fav.id));
  });

  // --- SSE ---
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const unsubscribe = hub.subscribe((ev) => {
        void stream.writeSSE({ event: 'check', data: JSON.stringify(ev), id: String(++id) }).catch(() => undefined);
      });
      const ping = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '' }).catch(() => undefined);
      }, 25_000);
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      unsubscribe();
    }),
  );

  app.all('/api/*', (c) => c.json({ error: 'Nicht gefunden.' }, 404));

  return app;
}
