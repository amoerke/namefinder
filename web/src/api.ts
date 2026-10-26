import type {
  ApiError, Favorite, GenerateRequest, NameSuggestion, ProviderInfo, Search,
} from '../../shared/types';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function req<T>(method: string, url: string, body?: unknown, opts: { auth401?: boolean } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new HttpError(0, 'Server nicht erreichbar. Prüfe deine Verbindung und versuche es erneut.');
  }
  if (res.status === 401 && opts.auth401 !== false) {
    onUnauthorized();
    throw new HttpError(401, 'Sitzung abgelaufen. Bitte erneut anmelden.');
  }
  if (!res.ok) {
    let msg = '';
    try { msg = ((await res.json()) as ApiError).error; } catch { /* kein JSON */ }
    if (res.status === 429) msg = msg || 'Limit erreicht. Bitte später erneut versuchen.';
    throw new HttpError(res.status, msg || `Anfrage fehlgeschlagen (${res.status}).`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  session: () => req<{ authenticated: boolean }>('GET', '/api/session', undefined, { auth401: false }),
  login: (password: string) => req<void>('POST', '/api/login', { password }, { auth401: false }),
  logout: () => req<void>('POST', '/api/logout'),
  providers: () => req<ProviderInfo[]>('GET', '/api/providers'),
  generate: (r: GenerateRequest) => req<Search>('POST', '/api/generate', r),
  searches: () => req<Search[]>('GET', '/api/searches'),
  search: (id: string) => req<Search>('GET', `/api/searches/${encodeURIComponent(id)}`),
  variants: (id: string) => req<NameSuggestion[]>('POST', `/api/suggestions/${encodeURIComponent(id)}/variants`),
  recheck: (id: string) => req<void>('POST', `/api/suggestions/${encodeURIComponent(id)}/recheck`),
  favorites: () => req<Favorite[]>('GET', '/api/favorites'),
  addFavorite: (suggestionId: string) => req<Favorite>('POST', '/api/favorites', { suggestionId }),
  patchFavorite: (id: string, p: { note?: string; rating?: number }) => req<Favorite>('PATCH', `/api/favorites/${encodeURIComponent(id)}`, p),
  deleteFavorite: (id: string) => req<void>('DELETE', `/api/favorites/${encodeURIComponent(id)}`),
  recheckFavorite: (id: string) => req<Favorite>('POST', `/api/favorites/${encodeURIComponent(id)}/recheck`),
};
