import type { DomainCheck, Tld } from "../../../shared/types.ts";
import { dnsPrefilter, defaultResolveNs } from "./dns.ts";
import { hyphenLabel, toLabel } from "./normalize.ts";
import { ThrottledQueue, runWithRetry } from "./queue.ts";
import { rdapCheck } from "./rdap.ts";

export interface CheckCache {
  get(domain: string): { status: "free" | "taken"; checkedAt: string } | null;
  set(domain: string, status: "free" | "taken", checkedAt: string): void;
}

export interface DomainChecker {
  enqueue(suggestionId: string, name: string, parts: string[], opts?: { force?: boolean }): DomainCheck[];
}

export interface CreateDomainCheckerOptions {
  cache: CheckCache;
  onUpdate: (suggestionId: string, check: DomainCheck) => void;
  freeTtlMs?: number;
  takenTtlMs?: number;
  fetchImpl?: typeof fetch;
  resolveNs?: (d: string) => Promise<string[]>;
  /** Throttle intervals per TLD (default de 2000 ms, com 250 ms). */
  intervalMs?: Partial<Record<Tld, number>>;
  retryAttempts?: number;
  retryBackoffMs?: number;
  now?: () => number;
  /** Delays for further re-checks of domains that stay 'unknown' after retries (default 30 s, 1 min, 2 min, 5 min). */
  unknownRecheckDelaysMs?: number[];
}

type Final = "free" | "taken" | "unknown";
const TLDS: Tld[] = ["de", "com"];

export function createDomainChecker(opts: CreateDomainCheckerOptions): DomainChecker {
  const freeTtl = opts.freeTtlMs ?? 60 * 60 * 1000;
  const takenTtl = opts.takenTtlMs ?? 24 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolveNs = opts.resolveNs ?? defaultResolveNs;
  const queues: Record<Tld, ThrottledQueue> = {
    de: new ThrottledQueue(opts.intervalMs?.de ?? 2000),
    com: new ThrottledQueue(opts.intervalMs?.com ?? 250),
  };
  const inflight = new Map<string, Promise<{ status: Final; checkedAt: string }>>();

  function cached(domain: string): { status: "free" | "taken"; checkedAt: string } | null {
    const hit = opts.cache.get(domain);
    if (!hit) return null;
    const age = now() - Date.parse(hit.checkedAt);
    const ttl = hit.status === "free" ? freeTtl : takenTtl;
    return age >= 0 && age < ttl ? hit : null;
  }

  async function lookup(domain: string, tld: Tld): Promise<Final> {
    if ((await dnsPrefilter(domain, resolveNs)) === "taken") return "taken";
    return runWithRetry(queues[tld], () => rdapCheck(domain, tld, fetchImpl), {
      attempts: opts.retryAttempts ?? 3,
      backoffMs: opts.retryBackoffMs ?? 5000,
    });
  }

  function check(domain: string, tld: Tld): Promise<{ status: Final; checkedAt: string }> {
    let p = inflight.get(domain);
    if (!p) {
      p = lookup(domain, tld)
        .catch((): Final => "unknown")
        .then((status) => {
          const checkedAt = new Date(now()).toISOString();
          if (status !== "unknown") opts.cache.set(domain, status, checkedAt);
          return { status, checkedAt };
        })
        .finally(() => inflight.delete(domain));
      inflight.set(domain, p);
    }
    return p;
  }

  /** Returns the immediate check (cache or pending) and reports the final result via onUpdate. */
  interface Recheck { timer: ReturnType<typeof setTimeout> | null; cancelled: boolean; listeners: Map<string, (s: Final) => void> }
  const rechecks = new Map<string, Recheck>();
  const recheckDelays = opts.unknownRecheckDelaysMs ?? [30_000, 60_000, 120_000, 300_000];

  function cancelRecheck(domain: string): void {
    const r = rechecks.get(domain);
    if (!r) return;
    r.cancelled = true;
    if (r.timer) clearTimeout(r.timer);
    rechecks.delete(domain);
  }

  /** Re-checks an 'unknown' domain after each configured delay; reports every result. */
  function scheduleRecheck(domain: string, tld: Tld, suggestionId: string, onFinal: (s: Final) => void): void {
    const existing = rechecks.get(domain);
    if (existing) {
      existing.listeners.set(suggestionId, onFinal);
      return;
    }
    if (recheckDelays.length === 0) return;
    const r: Recheck = { timer: null, cancelled: false, listeners: new Map([[suggestionId, onFinal]]) };
    rechecks.set(domain, r);
    const step = (i: number) => {
      r.timer = setTimeout(() => {
        r.timer = null;
        check(domain, tld).then(({ status, checkedAt }) => {
          if (r.cancelled) return;
          for (const [id, cb] of r.listeners) {
            opts.onUpdate(id, { domain, tld, status, checkedAt });
            cb(status);
          }
          if (status === "unknown" && i + 1 < recheckDelays.length) step(i + 1);
          else rechecks.delete(domain);
        });
      }, recheckDelays[i]);
      (r.timer as { unref?: () => void }).unref?.();
    };
    step(0);
  }

  /** Returns the immediate check (cache or pending); reports results via onUpdate and onFinal (also for rechecks). */
  function start(suggestionId: string, label: string, tld: Tld, force: boolean, onFinal: (s: Final) => void = () => {}): DomainCheck {
    const domain = `${label}.${tld}`;
    if (force) cancelRecheck(domain);
    const hit = force ? null : cached(domain);
    if (hit) {
      queueMicrotask(() => onFinal(hit.status));
      return { domain, tld, status: hit.status, checkedAt: hit.checkedAt };
    }
    check(domain, tld).then(({ status, checkedAt }) => {
      opts.onUpdate(suggestionId, { domain, tld, status, checkedAt });
      onFinal(status);
      if (status === "unknown") scheduleRecheck(domain, tld, suggestionId, onFinal);
    });
    return { domain, tld, status: "pending", checkedAt: null };
  }

  return {
    enqueue(suggestionId, name, parts, enqOpts) {
      const force = enqOpts?.force ?? false;
      const label = toLabel(name);
      if (!label) return [];
      const hyphen = hyphenLabel(parts);
      let fallbackStarted = false;
      const onResult = (status: Final) => {
        if (!hyphen || hyphen === label || status !== "taken" || fallbackStarted) return;
        fallbackStarted = true;
        for (const tld of TLDS) {
          // Always announce the fallback check, first as pending (or cached result).
          opts.onUpdate(suggestionId, start(suggestionId, hyphen, tld, force));
        }
      };
      return TLDS.map((tld) => start(suggestionId, label, tld, force, onResult));
    },
  };
}
