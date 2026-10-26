// Gemeinsamer API-Vertrag zwischen server/ und web/. Nur Typen, kein Laufzeitcode.

export type Tld = 'de' | 'com';

export type DomainStatus = 'pending' | 'free' | 'taken' | 'unknown';

export interface DomainCheck {
  domain: string; // z. B. "sonnenplan.de" oder "sonnen-plan.de"
  tld: Tld;
  status: DomainStatus;
  checkedAt: string | null; // ISO-Zeitstempel
}

export interface NameSuggestion {
  id: string;
  name: string; // Markenname, z. B. "SonnenPlan" (keine Umlaute, keine Bindestriche)
  parts: string[]; // Wortgrenzen, z. B. ["Sonnen", "Plan"]
  rationale: string; // kurze Begründung auf Deutsch
  isVariant: boolean; // true = regelbasierte Variante
  parentId: string | null;
  checks: DomainCheck[]; // primär ohne Bindestrich; Bindestrich-Fallback wird ergänzt
}

export type Language = 'de' | 'en' | 'international';
export type Provider = 'anthropic' | 'openai';

/** Ein konfigurierter KI-Anbieter (GET /api/providers). */
export interface ProviderInfo {
  id: Provider;
  label: string; // z. B. "Claude"
  model: string;
}
export type Style = 'kunstwort' | 'beschreibend' | 'kombination' | 'metapher';

export interface GenerateRequest {
  description: string;
  tags: string[];
  language: Language;
  styles: Style[];
  maxLength: number;
  count: number; // 10 | 20 | 30
  mustInclude: string;
  exclude: string;
  provider?: Provider; // fehlt bei alten Suchen (= Claude)
}

export interface Search {
  id: string;
  createdAt: string;
  request: GenerateRequest;
  suggestions: NameSuggestion[];
}

export interface Favorite {
  id: string;
  suggestionId: string;
  searchId: string | null;
  name: string;
  checks: DomainCheck[];
  note: string;
  rating: number; // 0–5
  createdAt: string;
}

// SSE-Event auf GET /api/events
export interface CheckUpdateEvent {
  suggestionId: string;
  check: DomainCheck;
}

export interface ApiError {
  error: string;
}

/*
 REST-Routen (alle unter /api, außer login/session durch Session-Cookie geschützt):
  POST   /api/login            { password } -> 204 | 401 | 429
  POST   /api/logout           -> 204
  GET    /api/session          -> { authenticated: boolean }
  GET    /api/providers        -> ProviderInfo[] (nur Anbieter mit gesetztem API-Key)
  POST   /api/generate         GenerateRequest -> Search   (Checks starten async, status 'pending'); 429 bei Limit
  GET    /api/searches         -> Search[] (neueste zuerst, max 50)
  GET    /api/searches/:id     -> Search
  POST   /api/suggestions/:id/variants -> NameSuggestion[]  (neue Varianten, Checks async)
  POST   /api/suggestions/:id/recheck  -> 204
  GET    /api/favorites        -> Favorite[]
  POST   /api/favorites        { suggestionId } -> Favorite
  PATCH  /api/favorites/:id    { note?, rating? } -> Favorite
  DELETE /api/favorites/:id    -> 204
  POST   /api/favorites/:id/recheck -> Favorite
  GET    /api/events           SSE, event "check" mit CheckUpdateEvent als data
*/
