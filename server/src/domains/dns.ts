import { Resolver } from "node:dns/promises";

export type DnsResult = "taken" | "maybe-free";
export type ResolveNs = (domain: string) => Promise<string[]>;

const resolver = new Resolver({ timeout: 3000, tries: 1 });
export const defaultResolveNs: ResolveNs = (d) => resolver.resolveNs(d);

/** NS records present => certainly registered. Anything else => ask RDAP. */
export async function dnsPrefilter(domain: string, resolveNs: ResolveNs = defaultResolveNs): Promise<DnsResult> {
  try {
    const ns = await Promise.race([
      resolveNs(domain),
      new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 3000).unref?.()),
    ]);
    return ns.length > 0 ? "taken" : "maybe-free";
  } catch {
    return "maybe-free";
  }
}
