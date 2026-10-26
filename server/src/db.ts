import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DomainCheck, Favorite, GenerateRequest, NameSuggestion, Search } from '../../shared/types.ts';
import type { CheckCache } from './domains/index.ts';

type Row = Record<string, unknown>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  request TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suggestions (
  id TEXT PRIMARY KEY,
  search_id TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  parts TEXT NOT NULL,
  rationale TEXT NOT NULL,
  is_variant INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  checks TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_suggestions_search ON suggestions(search_id, position);
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL UNIQUE,
  search_id TEXT,
  name TEXT NOT NULL,
  checks TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  rating INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS domain_cache (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
`;

export function mergeCheck(checks: DomainCheck[], check: DomainCheck): DomainCheck[] {
  const i = checks.findIndex((c) => c.domain === check.domain);
  if (i === -1) return [...checks, check];
  const next = [...checks];
  next[i] = check;
  return next;
}

export class Db implements CheckCache {
  readonly sql: DatabaseSync;

  constructor(path: string) {
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.sql.exec(SCHEMA);
  }

  static open(dataDir: string): Db {
    mkdirSync(dataDir, { recursive: true });
    return new Db(join(dataDir, 'namefinder.db'));
  }

  close(): void {
    this.sql.close();
  }

  // --- CheckCache ---
  get(domain: string): { status: 'free' | 'taken'; checkedAt: string } | null {
    const r = this.sql.prepare('SELECT status, checked_at FROM domain_cache WHERE domain = ?').get(domain) as Row | undefined;
    if (!r) return null;
    return { status: r.status as 'free' | 'taken', checkedAt: String(r.checked_at) };
  }

  set(domain: string, status: 'free' | 'taken', checkedAt: string): void {
    this.sql
      .prepare('INSERT INTO domain_cache (domain, status, checked_at) VALUES (?, ?, ?) ON CONFLICT(domain) DO UPDATE SET status = excluded.status, checked_at = excluded.checked_at')
      .run(domain, status, checkedAt);
  }

  // --- Sessions (token = SHA-256-Hash des Cookie-Tokens) ---
  createSession(tokenHash: string, expiresAt: number): void {
    this.sql.prepare('INSERT INTO sessions (token, expires_at) VALUES (?, ?)').run(tokenHash, expiresAt);
  }

  isSessionValid(tokenHash: string, now = Date.now()): boolean {
    const r = this.sql.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(tokenHash) as Row | undefined;
    return !!r && Number(r.expires_at) > now;
  }

  deleteSession(tokenHash: string): void {
    this.sql.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  }

  purgeExpiredSessions(now = Date.now()): number {
    return Number(this.sql.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
  }

  // --- Searches / Suggestions ---
  insertSearch(search: Search): void {
    this.sql.exec('BEGIN');
    try {
      this.sql.prepare('INSERT INTO searches (id, created_at, request) VALUES (?, ?, ?)').run(search.id, search.createdAt, JSON.stringify(search.request));
      this.insertSuggestionsRaw(search.id, search.suggestions);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  insertSuggestions(searchId: string, suggestions: NameSuggestion[]): void {
    this.sql.exec('BEGIN');
    try {
      this.insertSuggestionsRaw(searchId, suggestions);
      this.sql.exec('COMMIT');
    } catch (e) {
      this.sql.exec('ROLLBACK');
      throw e;
    }
  }

  private insertSuggestionsRaw(searchId: string, suggestions: NameSuggestion[]): void {
    const maxRow = this.sql.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM suggestions WHERE search_id = ?').get(searchId) as Row;
    let pos = Number(maxRow.m) + 1;
    const stmt = this.sql.prepare(
      'INSERT INTO suggestions (id, search_id, position, name, parts, rationale, is_variant, parent_id, checks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const s of suggestions) {
      stmt.run(s.id, searchId, pos++, s.name, JSON.stringify(s.parts), s.rationale, s.isVariant ? 1 : 0, s.parentId, JSON.stringify(s.checks));
    }
  }

  private toSuggestion(r: Row): NameSuggestion {
    return {
      id: String(r.id),
      name: String(r.name),
      parts: JSON.parse(String(r.parts)) as string[],
      rationale: String(r.rationale),
      isVariant: Number(r.is_variant) === 1,
      parentId: r.parent_id == null ? null : String(r.parent_id),
      checks: JSON.parse(String(r.checks)) as DomainCheck[],
    };
  }

  getSearch(id: string): Search | null {
    const r = this.sql.prepare('SELECT * FROM searches WHERE id = ?').get(id) as Row | undefined;
    if (!r) return null;
    const rows = this.sql.prepare('SELECT * FROM suggestions WHERE search_id = ? ORDER BY position').all(id) as Row[];
    return {
      id: String(r.id),
      createdAt: String(r.created_at),
      request: JSON.parse(String(r.request)) as GenerateRequest,
      suggestions: rows.map((x) => this.toSuggestion(x)),
    };
  }

  listSearches(limit = 50): Search[] {
    const ids = this.sql.prepare('SELECT id FROM searches ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
    return ids.map((r) => this.getSearch(String(r.id))).filter((s): s is Search => s !== null);
  }

  /** Zeitstempel der Suchen der letzten 24 h (für das globale Tageslimit nach Neustart). */
  recentSearchTimes(sinceMs: number): number[] {
    const rows = this.sql.prepare('SELECT created_at FROM searches WHERE created_at >= ?').all(new Date(sinceMs).toISOString()) as Row[];
    return rows.map((r) => Date.parse(String(r.created_at)));
  }

  getSuggestion(id: string): { suggestion: NameSuggestion; searchId: string } | null {
    const r = this.sql.prepare('SELECT * FROM suggestions WHERE id = ?').get(id) as Row | undefined;
    return r ? { suggestion: this.toSuggestion(r), searchId: String(r.search_id) } : null;
  }

  /** Check per Domain ersetzen oder anhängen – am Vorschlag und an Favoriten mit dieser suggestionId. */
  applyCheck(suggestionId: string, check: DomainCheck): void {
    const s = this.sql.prepare('SELECT checks FROM suggestions WHERE id = ?').get(suggestionId) as Row | undefined;
    if (s) {
      const next = mergeCheck(JSON.parse(String(s.checks)) as DomainCheck[], check);
      this.sql.prepare('UPDATE suggestions SET checks = ? WHERE id = ?').run(JSON.stringify(next), suggestionId);
    }
    const f = this.sql.prepare('SELECT id, checks FROM favorites WHERE suggestion_id = ?').get(suggestionId) as Row | undefined;
    if (f) {
      const next = mergeCheck(JSON.parse(String(f.checks)) as DomainCheck[], check);
      this.sql.prepare('UPDATE favorites SET checks = ? WHERE id = ?').run(JSON.stringify(next), String(f.id));
    }
  }

  // --- Favorites ---
  private toFavorite(r: Row): Favorite {
    return {
      id: String(r.id),
      suggestionId: String(r.suggestion_id),
      searchId: r.search_id == null ? null : String(r.search_id),
      name: String(r.name),
      checks: JSON.parse(String(r.checks)) as DomainCheck[],
      note: String(r.note),
      rating: Number(r.rating),
      createdAt: String(r.created_at),
    };
  }

  listFavorites(): Favorite[] {
    return (this.sql.prepare('SELECT * FROM favorites ORDER BY created_at DESC').all() as Row[]).map((r) => this.toFavorite(r));
  }

  getFavorite(id: string): Favorite | null {
    const r = this.sql.prepare('SELECT * FROM favorites WHERE id = ?').get(id) as Row | undefined;
    return r ? this.toFavorite(r) : null;
  }

  /** Legt Favorit als Snapshot an; existiert er schon für die suggestionId, wird dieser zurückgegeben. */
  addFavorite(suggestionId: string): Favorite | null {
    const existing = this.sql.prepare('SELECT * FROM favorites WHERE suggestion_id = ?').get(suggestionId) as Row | undefined;
    if (existing) return this.toFavorite(existing);
    const found = this.getSuggestion(suggestionId);
    if (!found) return null;
    const fav: Favorite = {
      id: randomUUID(),
      suggestionId,
      searchId: found.searchId,
      name: found.suggestion.name,
      checks: found.suggestion.checks,
      note: '',
      rating: 0,
      createdAt: new Date().toISOString(),
    };
    this.sql
      .prepare('INSERT INTO favorites (id, suggestion_id, search_id, name, checks, note, rating, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(fav.id, fav.suggestionId, fav.searchId, fav.name, JSON.stringify(fav.checks), fav.note, fav.rating, fav.createdAt);
    return fav;
  }

  updateFavorite(id: string, patch: { note?: string; rating?: number }): Favorite | null {
    if (patch.note !== undefined) this.sql.prepare('UPDATE favorites SET note = ? WHERE id = ?').run(patch.note, id);
    if (patch.rating !== undefined) this.sql.prepare('UPDATE favorites SET rating = ? WHERE id = ?').run(patch.rating, id);
    return this.getFavorite(id);
  }

  setFavoriteChecks(id: string, checks: DomainCheck[]): void {
    this.sql.prepare('UPDATE favorites SET checks = ? WHERE id = ?').run(JSON.stringify(checks), id);
  }

  deleteFavorite(id: string): boolean {
    return Number(this.sql.prepare('DELETE FROM favorites WHERE id = ?').run(id).changes) > 0;
  }
}
