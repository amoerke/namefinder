import type { Tld } from "../../../shared/types.ts";

export type RdapResult = "free" | "taken" | "unknown";

export function rdapUrl(domain: string, tld: Tld): string {
  return tld === "de"
    ? `https://rdap.denic.de/domain/${domain}`
    : `https://rdap.verisign.com/com/v1/domain/${domain}`;
}

export function mapRdapStatus(status: number): RdapResult {
  if (status === 200) return "taken";
  if (status === 404) return "free";
  return "unknown";
}

export async function rdapCheck(domain: string, tld: Tld, fetchImpl: typeof fetch = fetch, timeoutMs = 8000): Promise<RdapResult> {
  try {
    const res = await fetchImpl(rdapUrl(domain, tld), {
      headers: { accept: "application/rdap+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    res.body?.cancel().catch(() => {});
    return mapRdapStatus(res.status);
  } catch {
    return "unknown";
  }
}
