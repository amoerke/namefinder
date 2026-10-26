import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CheckUpdateEvent, Favorite, GenerateRequest, NameSuggestion, ProviderInfo, Search } from '../../shared/types';
import { api, HttpError, setUnauthorizedHandler } from './api';
import { bothFree, isPending, isUnchecked, mergeCheck } from './domain';
import { EMPTY_REQ, Favorites, History, Login, SearchForm, SuggestionCard } from './components';

type Auth = 'loading' | 'out' | 'in';
type Tab = 'ergebnisse' | 'favoriten' | 'verlauf';

export default function App() {
  const [auth, setAuth] = useState<Auth>('loading');
  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api.session().then(r => setAuth(r?.authenticated ? 'in' : 'out')).catch(() => setAuth('out'));
  }, []);
  if (auth === 'loading') return <div className="boot" aria-busy="true" />;
  if (auth === 'out') return <Login onDone={() => setAuth('in')} />;
  return <Main onLogout={() => setAuth('out')} />;
}

function Main({ onLogout }: { onLogout: () => void }) {
  const [req, setReq] = useState<GenerateRequest>(EMPTY_REQ);
  const [search, setSearch] = useState<Search | null>(null);
  const [sugs, setSugs] = useState<NameSuggestion[]>([]);
  const [favs, setFavs] = useState<Favorite[]>([]);
  const [history, setHistory] = useState<Search[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [tab, setTab] = useState<Tab>('ergebnisse');
  const [variantBusy, setVariantBusy] = useState<Set<string>>(new Set());
  const [checkBusy, setCheckBusy] = useState<Set<string>>(new Set());
  const [providers, setProviders] = useState<ProviderInfo[]>([]);

  const fail = useCallback((x: unknown) => {
    if (x instanceof HttpError && x.status === 401) return;
    setNotice(x instanceof Error ? x.message : String(x));
  }, []);

  useEffect(() => {
    api.favorites().then(setFavs).catch(fail);
    api.searches().then(setHistory).catch(fail);
    api.providers().then(list => {
      setProviders(list);
      // Voreinstellung: erster eingerichteter Anbieter, falls noch keiner (oder ein nicht mehr verfügbarer) gewählt ist.
      setReq(r => (list.some(p => p.id === r.provider) ? r : { ...r, provider: list[0]?.id }));
    }).catch(fail);
  }, [fail]);

  // Live-Updates
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.addEventListener('check', (ev) => {
      let d: CheckUpdateEvent;
      try { d = JSON.parse((ev as MessageEvent).data); } catch { return; }
      setSugs(prev => prev.map(s => (s.id === d.suggestionId ? mergeCheck(s, d.check) : s)));
      setFavs(prev => prev.map(f => {
        if (f.suggestionId !== d.suggestionId) return f;
        const i = f.checks.findIndex(c => c.domain === d.check.domain);
        return { ...f, checks: i === -1 ? [...f.checks, d.check] : f.checks.map((c, j) => (j === i ? d.check : c)) };
      }));
    });
    return () => es.close();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const load = (s: Search) => {
    setSearch(s); setSugs(s.suggestions); setTab('ergebnisse');
    // Alte Suchen haben keinen Anbieter, und ein Anbieter kann inzwischen fehlen – dann die aktuelle Wahl behalten.
    setReq(r => ({ ...s.request, provider: providers.some(p => p.id === s.request.provider) ? s.request.provider : r.provider }));
  };

  async function generate() {
    setBusy(true); setErr(null);
    try {
      const s = await api.generate(req);
      load(s);
      setHistory(h => [s, ...h.filter(x => x.id !== s.id)].slice(0, 50));
    } catch (x) {
      if (x instanceof HttpError && x.status === 401) return;
      setErr(x instanceof HttpError && x.status === 429
        ? `Tageslimit erreicht: ${x.message} Versuche es später erneut.`
        : `Die Namenssuche ist fehlgeschlagen. ${(x as Error).message}`);
    } finally { setBusy(false); }
  }

  async function openSearch(id: string) {
    try { load(await api.search(id)); } catch (x) { fail(x); }
  }

  async function variants(id: string) {
    setVariantBusy(s => new Set(s).add(id));
    try {
      const v = await api.variants(id);
      setSugs(prev => [...prev.filter(p => !v.some(n => n.id === p.id)), ...v]);
      if (!v.length) setNotice('Keine weiteren Varianten gefunden.');
    } catch (x) { fail(x); }
    finally { setVariantBusy(s => { const n = new Set(s); n.delete(id); return n; }); }
  }

  async function check(id: string) {
    setCheckBusy(s => new Set(s).add(id));
    try {
      const checks = await api.check(id);
      setSugs(prev => prev.map(s => s.id === id ? checks.reduce(mergeCheck, s) : s));
    } catch (x) { fail(x); }
    finally { setCheckBusy(s => { const n = new Set(s); n.delete(id); return n; }); }
  }

  // Der Server drosselt die RDAP-Abfragen selbst, daher alle auf einmal anstoßen.
  const checkAll = () => Promise.all(sugs.filter(s => isUnchecked(s.checks) && !checkBusy.has(s.id)).map(s => check(s.id)));

  async function recheck(id: string) {
    setSugs(prev => prev.map(s => s.id === id ? { ...s, checks: s.checks.map(c => ({ ...c, status: 'pending' as const })) } : s));
    try { await api.recheck(id); } catch (x) { fail(x); }
  }

  async function toggleFav(s: NameSuggestion) {
    const f = favs.find(x => x.suggestionId === s.id);
    try {
      if (f) { await api.deleteFavorite(f.id); setFavs(p => p.filter(x => x.id !== f.id)); }
      else { const n = await api.addFavorite(s.id); setFavs(p => [...p, n]); }
    } catch (x) { fail(x); }
  }

  const patchFav = async (id: string, p: { note?: string; rating?: number }) => {
    if (p.rating !== undefined) setFavs(prev => prev.map(f => f.id === id ? { ...f, rating: p.rating! } : f));
    try { const n = await api.patchFavorite(id, p); setFavs(prev => prev.map(f => f.id === id ? { ...f, rating: n.rating } : f)); }
    catch (x) { fail(x); }
  };
  const deleteFav = async (id: string) => {
    try { await api.deleteFavorite(id); setFavs(p => p.filter(f => f.id !== id)); } catch (x) { fail(x); }
  };
  const recheckFav = async (id: string) => {
    setFavs(prev => prev.map(f => f.id === id ? { ...f, checks: f.checks.map(c => ({ ...c, status: 'pending' as const })) } : f));
    try { const n = await api.recheckFavorite(id); setFavs(prev => prev.map(f => f.id === id ? n : f)); } catch (x) { fail(x); }
  };

  async function logout() { try { await api.logout(); } catch { /* egal */ } onLogout(); }

  // Gruppierung: Eltern + Varianten
  const groups = useMemo(() => {
    const parents = sugs.filter(s => !s.isVariant || !s.parentId || !sugs.some(p => p.id === s.parentId));
    return parents.map(p => ({ parent: p, children: sugs.filter(c => c.isVariant && c.parentId === p.id) }));
  }, [sugs]);
  // Ungeprüfte Namen immer zeigen: der Nutzer entscheidet erst anhand der Namen, was geprüft wird.
  const passes = (s: NameSuggestion) => showAll || isUnchecked(s.checks) || bothFree(s.checks) || isPending(s.checks);
  const visible = groups.filter(g => passes(g.parent) || g.children.some(passes));

  const allChecks = sugs.flatMap(s => s.checks);
  const done = allChecks.filter(c => c.status !== 'pending').length;
  const freeCount = sugs.filter(s => bothFree(s.checks)).length;
  const running = done < allChecks.length;
  const uncheckedCount = sugs.filter(s => isUnchecked(s.checks)).length;

  let idx = 0;
  const card = (s: NameSuggestion, canVariants: boolean) => (
    <SuggestionCard key={s.id} s={s} index={idx++} fav={favs.some(f => f.suggestionId === s.id)}
      dim={!showAll && !isUnchecked(s.checks) && !bothFree(s.checks)} variantsBusy={variantBusy.has(s.id)}
      checkBusy={checkBusy.has(s.id)} onFav={() => toggleFav(s)} onCheck={() => check(s.id)} onRecheck={() => recheck(s.id)} onVariants={canVariants ? () => variants(s.id) : undefined} />
  );

  return (
    <div className="shell">
      <header className="top">
        <span className="wordmark">Namens<span>finder</span></span>
        <button className="btn ghost sm" onClick={logout}>Abmelden</button>
      </header>

      <aside className="left">
        <SearchForm value={req} onChange={setReq} onSubmit={generate} busy={busy} providers={providers} />
        {err && <p className="error" role="alert">{err}</p>}
      </aside>

      <main className="right">
        <nav className="tabs" role="tablist" aria-label="Bereiche">
          {([['ergebnisse', 'Ergebnisse'], ['favoriten', `Favoriten${favs.length ? ` (${favs.length})` : ''}`], ['verlauf', 'Verlauf']] as [Tab, string][]).map(([k, l]) => (
            <button key={k} role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls={`panel-${k}`} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </nav>

        {tab === 'ergebnisse' && (
          <section id="panel-ergebnisse" role="tabpanel" aria-labelledby="tab-ergebnisse">
            {busy && !sugs.length && <Waiting label={providers.find(p => p.id === req.provider)?.label ?? 'Die KI'} />}
            {busy && sugs.length > 0 && <p className="status-line" role="status">Neue Namen werden erdacht – das dauert 20 bis 80 Sekunden.</p>}
            {!busy && !search && <p className="empty big">Beschreibe links, was deine Firma macht. Hier erscheinen dann Namen, deren .de- und .com-Domain du live prüfen kannst.</p>}
            {search && (
              <>
                <div className="results-bar">
                  <div className="progress" role="status" aria-live="polite">
                    <div className="bar"><span style={{ width: `${allChecks.length ? (done / allChecks.length) * 100 : 0}%` }} /></div>
                    <span>{done}/{allChecks.length} Domains geprüft{running || !allChecks.length ? '' : ' – fertig'}, {freeCount} mit .de und .com frei{uncheckedCount > 0 && `, ${uncheckedCount} Namen ungeprüft`}</span>
                  </div>
                  {uncheckedCount > 0 && <button type="button" className="btn primary sm" onClick={checkAll}>Alle Domains prüfen</button>}
                  <div className="seg" role="group" aria-label="Filter">
                    <button type="button" className={'seg-btn' + (!showAll ? ' on' : '')} aria-pressed={!showAll} onClick={() => setShowAll(false)}>Beide frei</button>
                    <button type="button" className={'seg-btn' + (showAll ? ' on' : '')} aria-pressed={showAll} onClick={() => setShowAll(true)}>Alle</button>
                  </div>
                </div>
                {!visible.length && <p className="empty">Für keinen geprüften Namen sind .de und .com gleichzeitig frei. Zeige „Alle“ und suche freie Varianten, oder starte eine neue Suche.</p>}
                <div className="cards">
                  {visible.map(g => (
                    <div className="group" key={g.parent.id}>
                      {card(g.parent, !g.parent.isVariant)}
                      {g.children.filter(passes).length > 0 && <div className="children">{g.children.filter(passes).map(c => card(c, false))}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
        {tab === 'favoriten' && (
          <section id="panel-favoriten" role="tabpanel" aria-labelledby="tab-favoriten">
            <Favorites items={favs} onPatch={patchFav} onDelete={deleteFav} onRecheck={recheckFav} />
          </section>
        )}
        {tab === 'verlauf' && (
          <section id="panel-verlauf" role="tabpanel" aria-labelledby="tab-verlauf">
            <History items={history} current={search?.id} onOpen={openSearch} />
          </section>
        )}
      </main>
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}

function Waiting({ label }: { label: string }) {
  return (
    <div className="waiting" role="status">
      <div className="ghosts" aria-hidden>{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ ['--i' as string]: i }} />)}</div>
      <p>{label} erdenkt Namen – das dauert 20 bis 80 Sekunden. Danach kannst du die Domains live prüfen.</p>
    </div>
  );
}
