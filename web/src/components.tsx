import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { DomainCheck, Favorite, GenerateRequest, Language, NameSuggestion, ProviderInfo, Search, Style } from '../../shared/types';
import { api, HttpError } from './api';
import { bothFree, fmtTime, groupChecks, isPending } from './domain';

const STATUS_TEXT: Record<DomainCheck['status'], string> = {
  free: 'frei', taken: 'vergeben', pending: 'prüfe…', unknown: 'unklar',
};

/* ---------- Login ---------- */
export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await api.login(pw); onDone(); }
    catch (x) {
      const s = x instanceof HttpError ? x.status : 0;
      setErr(s === 401 ? 'Passwort falsch.'
        : s === 429 ? 'Zu viele Versuche. Der Zugang ist vorübergehend gesperrt – bitte warte einige Minuten.'
        : (x as Error).message);
    } finally { setBusy(false); }
  }
  return (
    <main className="login">
      <form onSubmit={submit} className="login-box">
        <h1 className="wordmark">Namens<span>finder</span></h1>
        <p className="muted">Firmennamen finden, deren .de und .com noch frei sind.</p>
        <label htmlFor="pw">Passwort</label>
        <input id="pw" type="password" autoFocus autoComplete="current-password" value={pw}
          onChange={e => setPw(e.target.value)} aria-invalid={!!err} aria-describedby={err ? 'pw-err' : undefined} />
        {err && <p id="pw-err" className="error" role="alert">{err}</p>}
        <button className="btn primary" disabled={busy || !pw}>{busy ? 'Anmelden…' : 'Anmelden'}</button>
      </form>
    </main>
  );
}

/* ---------- Tags ---------- */
function TagInput({ id, value, onChange }: { id: string; value: string[]; onChange: (v: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const commit = (raw: string) => {
    const parts = raw.split(',').map(s => s.trim()).filter(Boolean).filter(s => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(draft); }
    else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="tags">
      {value.map(t => (
        <span className="chip" key={t}>{t}
          <button type="button" aria-label={`${t} entfernen`} onClick={() => onChange(value.filter(x => x !== t))}>×</button>
        </span>
      ))}
      <input id={id} value={draft} onChange={e => e.target.value.endsWith(',') ? commit(e.target.value) : setDraft(e.target.value)}
        onKeyDown={onKey} onBlur={() => draft && commit(draft)} placeholder={value.length ? '' : 'z. B. Solar, Beratung'} />
    </div>
  );
}

/* ---------- Formular ---------- */
const STYLES: [Style, string][] = [['kunstwort', 'Kunstwort'], ['beschreibend', 'Beschreibend'], ['kombination', 'Kombination'], ['metapher', 'Metapher']];
const LANGS: [Language, string][] = [['de', 'Deutsch'], ['en', 'Englisch'], ['international', 'International']];
export const EMPTY_REQ: GenerateRequest = { description: '', tags: [], language: 'de', styles: ['kombination'], maxLength: 12, count: 20, mustInclude: '', exclude: '' };

export function SearchForm({ value, onChange, onSubmit, busy, providers }: {
  value: GenerateRequest; onChange: (r: GenerateRequest) => void; onSubmit: () => void; busy: boolean; providers: ProviderInfo[];
}) {
  const set = <K extends keyof GenerateRequest>(k: K, v: GenerateRequest[K]) => onChange({ ...value, [k]: v });
  const toggleStyle = (s: Style) => set('styles', value.styles.includes(s) ? value.styles.filter(x => x !== s) : [...value.styles, s]);
  return (
    <form className="form" onSubmit={e => { e.preventDefault(); onSubmit(); }}>
      <div className="field">
        <label htmlFor="desc">Was macht deine Firma?</label>
        <textarea id="desc" rows={4} required value={value.description} onChange={e => set('description', e.target.value)}
          placeholder="Wir planen und installieren Solaranlagen für Einfamilienhäuser in Norddeutschland." />
      </div>
      <div className="field">
        <label htmlFor="tags">Geschäftsfelder <span className="hint">Enter oder Komma trennt</span></label>
        <TagInput id="tags" value={value.tags} onChange={v => set('tags', v)} />
      </div>
      <fieldset className="field">
        <legend>Sprache</legend>
        <div className="seg">
          {LANGS.map(([k, l]) => (
            <label key={k} className="seg-opt"><input type="radio" name="lang" checked={value.language === k} onChange={() => set('language', k)} /><span>{l}</span></label>
          ))}
        </div>
      </fieldset>
      <fieldset className="field">
        <legend>Stil</legend>
        <div className="seg wrap">
          {STYLES.map(([k, l]) => (
            <label key={k} className="seg-opt"><input type="checkbox" checked={value.styles.includes(k)} onChange={() => toggleStyle(k)} /><span>{l}</span></label>
          ))}
        </div>
      </fieldset>
      <div className="row2">
        <div className="field">
          <label htmlFor="len">Maximale Länge <output htmlFor="len" className="num">{value.maxLength} Zeichen</output></label>
          <input id="len" type="range" min={4} max={20} value={value.maxLength} onChange={e => set('maxLength', Number(e.target.value))} />
        </div>
        <fieldset className="field">
          <legend>Anzahl</legend>
          <div className="seg">
            {[10, 20, 30].map(n => (
              <label key={n} className="seg-opt"><input type="radio" name="count" checked={value.count === n} onChange={() => set('count', n)} /><span>{n}</span></label>
            ))}
          </div>
        </fieldset>
      </div>
      {providers.length > 1 && (
        <fieldset className="field">
          <legend>KI-Anbieter</legend>
          <div className="seg">
            {providers.map(p => (
              <label key={p.id} className="seg-opt" title={p.model}><input type="radio" name="provider" checked={value.provider === p.id} onChange={() => set('provider', p.id)} /><span>{p.label}</span></label>
            ))}
          </div>
        </fieldset>
      )}
      <details className="more">
        <summary>Muss- und Ausschluss-Wörter</summary>
        <div className="row2">
          <div className="field"><label htmlFor="must">Muss enthalten</label>
            <input id="must" value={value.mustInclude} onChange={e => set('mustInclude', e.target.value)} placeholder="z. B. sol" /></div>
          <div className="field"><label htmlFor="excl">Nicht verwenden</label>
            <input id="excl" value={value.exclude} onChange={e => set('exclude', e.target.value)} placeholder="z. B. energie, power" /></div>
        </div>
      </details>
      <button className="btn primary big" disabled={busy || !providers.length || !value.description.trim() || !value.styles.length}>
        {busy ? <><span className="spinner" aria-hidden /> Namen werden erdacht…</> : 'Namen finden'}
      </button>
      {!value.styles.length && <p className="hint">Wähle mindestens einen Stil.</p>}
      {!providers.length && <p className="hint">Auf dem Server ist kein KI-Anbieter eingerichtet (ANTHROPIC_API_KEY oder OPENAI_API_KEY fehlt).</p>}
    </form>
  );
}

/* ---------- Badges ---------- */
export function DomainBadges({ checks, showTime }: { checks: DomainCheck[]; showTime?: boolean }) {
  return (
    <div className="badges">
      {groupChecks(checks).map(g => (
        <div className={'spelling' + (g.spelling.includes('-') ? ' hyphen' : '')} key={g.spelling}>
          {g.checks.map(c => (
            <span key={c.domain} className={`badge ${c.status}`} title={c.checkedAt ? `geprüft ${fmtTime(c.checkedAt)}` : undefined}>
              <span className="dom">{c.domain}</span>
              <span className="st">{STATUS_TEXT[c.status]}</span>
            </span>
          ))}
          {showTime && <span className="time">{fmtTime(latest(g.checks))}</span>}
        </div>
      ))}
    </div>
  );
}
const latest = (cs: DomainCheck[]) => cs.map(c => c.checkedAt).filter(Boolean).sort().pop() ?? null;

/* ---------- Karte ---------- */
export function SuggestionCard({ s, fav, dim, onFav, onVariants, onRecheck, variantsBusy, index }: {
  s: NameSuggestion; fav: boolean; dim: boolean; index: number; variantsBusy: boolean;
  onFav: () => void; onVariants?: () => void; onRecheck: () => void;
}) {
  const free = bothFree(s.checks);
  return (
    <article className={'card' + (dim ? ' dim' : '') + (free ? ' free' : '') + (s.isVariant ? ' variant' : '')}
      style={{ ['--i' as string]: Math.min(index, 12) }}>
      <div className="card-head">
        <h3 className="name">{s.parts.length > 1 ? s.parts.map((p, i) => <span key={i} className={i % 2 ? 'alt' : ''}>{p}</span>) : s.name}</h3>
        <button type="button" className={'star' + (fav ? ' on' : '')} aria-pressed={fav}
          aria-label={fav ? `${s.name} aus Favoriten entfernen` : `${s.name} als Favorit merken`} onClick={onFav}>
          <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" /></svg>
        </button>
      </div>
      {s.rationale && <p className="why">{s.rationale}</p>}
      <DomainBadges checks={s.checks} />
      <div className="actions">
        {onVariants && <button type="button" className="btn ghost sm" onClick={onVariants} disabled={variantsBusy}>
          {variantsBusy ? 'Suche Varianten…' : 'Freie Varianten suchen'}</button>}
        <button type="button" className="btn ghost sm" onClick={onRecheck} disabled={isPending(s.checks)}>Neu prüfen</button>
      </div>
    </article>
  );
}

/* ---------- Favoriten ---------- */
const enc = encodeURIComponent;
function Links({ name }: { name: string }) {
  const links: [string, string][] = [
    ['DPMAregister', 'https://register.dpma.de/DPMAregister/marke/einsteiger'],
    ['TMview', `https://www.tmdn.org/tmview/#/tmview/results?page=1&pageSize=30&criteria=C&basicSearch=${enc(name)}`],
    ['Handelsregister', 'https://www.handelsregister.de/'],
    ['Northdata', `https://www.northdata.de/${enc(name)}`],
  ];
  return (
    <div className="links">
      {links.map(([l, h]) => <a key={l} href={h} target="_blank" rel="noopener noreferrer">{l}<span className="sr">(öffnet neuen Tab)</span></a>)}
    </div>
  );
}

function Stars({ value, onChange, name }: { value: number; onChange: (n: number) => void; name: string }) {
  return (
    <div className="stars" role="radiogroup" aria-label={`Bewertung für ${name}`}>
      {[1, 2, 3, 4, 5].map(n => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} von 5`}
          className={n <= value ? 'on' : ''} onClick={() => onChange(value === n ? 0 : n)}>★</button>
      ))}
    </div>
  );
}

function FavoriteItem({ f, onPatch, onDelete, onRecheck }: {
  f: Favorite; onPatch: (p: { note?: string; rating?: number }) => void; onDelete: () => void; onRecheck: () => void;
}) {
  const [note, setNote] = useState(f.note);
  const t = useRef<number | undefined>(undefined);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => onPatch({ note }), 600);
    return () => window.clearTimeout(t.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note]);
  return (
    <li className="fav">
      <div className="fav-head">
        <h3 className="name sm">{f.name}</h3>
        <Stars value={f.rating} name={f.name} onChange={r => onPatch({ rating: r })} />
      </div>
      <DomainBadges checks={f.checks} showTime />
      <label className="sr" htmlFor={`note-${f.id}`}>Notiz zu {f.name}</label>
      <textarea id={`note-${f.id}`} className="note" rows={2} placeholder="Notiz hinzufügen…" value={note} onChange={e => setNote(e.target.value)} />
      <Links name={f.name} />
      <div className="actions">
        <button type="button" className="btn ghost sm" onClick={onRecheck} disabled={isPending(f.checks)}>Neu prüfen</button>
        <button type="button" className="btn ghost sm danger" onClick={onDelete}>Entfernen</button>
      </div>
    </li>
  );
}

export function Favorites({ items, onPatch, onDelete, onRecheck }: {
  items: Favorite[]; onPatch: (id: string, p: { note?: string; rating?: number }) => void;
  onDelete: (id: string) => void; onRecheck: (id: string) => void;
}) {
  if (!items.length) return <p className="empty">Noch keine Favoriten. Markiere Namen in den Ergebnissen mit dem Stern.</p>;
  const sorted = [...items].sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  return (
    <ul className="favs">
      {sorted.map(f => <FavoriteItem key={f.id} f={f} onPatch={p => onPatch(f.id, p)} onDelete={() => onDelete(f.id)} onRecheck={() => onRecheck(f.id)} />)}
    </ul>
  );
}

/* ---------- Verlauf ---------- */
export function History({ items, current, onOpen }: { items: Search[]; current?: string; onOpen: (id: string) => void }) {
  if (!items.length) return <p className="empty">Noch keine Suchen. Beschreibe deine Firma, um zu starten.</p>;
  return (
    <ul className="history">
      {items.map(s => (
        <li key={s.id}>
          <button type="button" className={s.id === current ? 'current' : ''} aria-current={s.id === current || undefined} onClick={() => onOpen(s.id)}>
            <span className="h-desc">{s.request.description}</span>
            <span className="h-meta">{fmtTime(s.createdAt)} – {s.suggestions.filter(x => !x.isVariant).length} Namen – {s.request.provider === 'openai' ? 'OpenAI' : 'Claude'}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
