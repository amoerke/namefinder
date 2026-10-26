import { describe, expect, it, vi } from "vitest";
import type { DomainCheck } from "../../../shared/types.ts";
import { createDomainChecker, type CheckCache } from "./checker.ts";

function memCache(init: Record<string, { status: "free" | "taken"; checkedAt: string }> = {}): CheckCache & { data: typeof init } {
  const data = { ...init };
  return { data, get: (d) => data[d] ?? null, set: (d, status, checkedAt) => { data[d] = { status, checkedAt }; } };
}

function setup(statusFor: (domain: string) => number, cache = memCache(), ns: Record<string, string[]> = {}, extra: { unknownRecheckDelaysMs?: number[] } = {}) {
  const updates: [string, DomainCheck][] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const domain = String(url).split("/").pop()!;
    return new Response(null, { status: statusFor(domain) });
  });
  const checker = createDomainChecker({
    cache,
    onUpdate: (id, c) => updates.push([id, c]),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    resolveNs: async (d) => ns[d] ?? [],
    intervalMs: { de: 1, com: 1 },
    retryBackoffMs: 1,
    unknownRecheckDelaysMs: [],
    ...extra,
  });
  return { checker, updates, fetchImpl, cache };
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const final = (updates: [string, DomainCheck][]) => {
  const m: Record<string, string> = {};
  for (const [, c] of updates) m[c.domain] = c.status;
  return m;
};

describe("createDomainChecker", () => {
  it("returns pending primary checks and reports results", async () => {
    const { checker, updates, cache } = setup((d) => (d === "foo.de" ? 404 : 200), memCache(), { "foo.com": ["ns1"] });
    const initial = checker.enqueue("s1", "Foo", ["Foo"]);
    expect(initial.map((c) => [c.domain, c.status])).toEqual([["foo.de", "pending"], ["foo.com", "pending"]]);
    await settle();
    expect(final(updates)).toEqual({ "foo.de": "free", "foo.com": "taken" });
    expect(cache.data["foo.com"].status).toBe("taken");
  });

  it("uses cache within TTL, ignores expired entries and force", async () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 2 * 3600_000).toISOString();
    const cache = memCache({ "foo.de": { status: "free", checkedAt: now }, "foo.com": { status: "free", checkedAt: old } });
    const { checker, fetchImpl } = setup(() => 404, cache);
    const initial = checker.enqueue("s1", "Foo", []);
    expect(initial[0]).toMatchObject({ domain: "foo.de", status: "free", checkedAt: now });
    expect(initial[1].status).toBe("pending"); // free TTL 1h expired
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const forced = checker.enqueue("s1", "Foo", [], { force: true });
    expect(forced.every((c) => c.status === "pending")).toBe(true);
  });

  it("taken cache entries live 24h", () => {
    const old = new Date(Date.now() - 23 * 3600_000).toISOString();
    const cache = memCache({ "foo.de": { status: "taken", checkedAt: old } });
    const { checker } = setup(() => 404, cache);
    expect(checker.enqueue("s", "Foo", [])[0].status).toBe("taken");
  });

  it("adds hyphen fallback when a primary is taken", async () => {
    const { checker, updates } = setup((d) => (d === "sonnenplan.de" ? 200 : 404));
    checker.enqueue("s1", "SonnenPlan", ["Sonnen", "Plan"]);
    await settle();
    const pend = updates.filter(([, c]) => c.domain.includes("-") && c.status === "pending").map(([, c]) => c.domain);
    expect(pend.sort()).toEqual(["sonnen-plan.com", "sonnen-plan.de"]);
    expect(final(updates)).toEqual({
      "sonnenplan.de": "taken", "sonnenplan.com": "free", "sonnen-plan.de": "free", "sonnen-plan.com": "free",
    });
  });

  it("no fallback when both free", async () => {
    const { checker, updates } = setup(() => 404);
    checker.enqueue("s1", "SonnenPlan", ["Sonnen", "Plan"]);
    await settle();
    expect(updates.some(([, c]) => c.domain.includes("-"))).toBe(false);
  });

  it("retries unknown and finally reports unknown", async () => {
    const { checker, updates, fetchImpl } = setup(() => 429);
    checker.enqueue("s1", "Foo", []);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    expect(final(updates)).toEqual({ "foo.de": "unknown", "foo.com": "unknown" });
  });

  it("dedupes concurrent checks of the same domain", async () => {
    const { checker, updates, fetchImpl } = setup(() => 404);
    checker.enqueue("a", "Foo", []);
    checker.enqueue("b", "Foo", []);
    await settle();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(updates.filter(([id]) => id === "b")).toHaveLength(2);
  });

  it("rechecks unknown domains after the configured delays and reports each result", async () => {
    let calls = 0;
    const { checker, updates } = setup(() => (++calls <= 9 ? 429 : 404), memCache(), {}, { unknownRecheckDelaysMs: [5, 5, 5, 5] });
    checker.enqueue("s1", "Foo", []);
    // .de only via filter: 3 initial + 3 per recheck
    await new Promise((r) => setTimeout(r, 200));
    const de = updates.filter(([, c]) => c.domain === "foo.de").map(([, c]) => c.status);
    expect(de[0]).toBe("unknown");
    expect(de.at(-1)).toBe("free");
  });

  it("stops after the last recheck delay", async () => {
    const { checker, updates, fetchImpl } = setup(() => 503, memCache(), {}, { unknownRecheckDelaysMs: [5, 5] });
    checker.enqueue("s1", "Foo", []);
    await new Promise((r) => setTimeout(r, 200));
    const de = updates.filter(([, c]) => c.domain === "foo.de").map(([, c]) => c.status);
    expect(de).toEqual(["unknown", "unknown", "unknown"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2 * 3 * 3);
  });

  it("force enqueue replaces a running recheck", async () => {
    let fail = true;
    const { checker, updates } = setup(() => (fail ? 429 : 404), memCache(), {}, { unknownRecheckDelaysMs: [80] });
    checker.enqueue("s1", "Foo", []);
    await settle();
    fail = false;
    checker.enqueue("s1", "Foo", [], { force: true });
    await new Promise((r) => setTimeout(r, 200));
    const de = updates.filter(([, c]) => c.domain === "foo.de").map(([, c]) => c.status);
    expect(de).toEqual(["unknown", "free"]); // cancelled recheck reports nothing
  });
});
