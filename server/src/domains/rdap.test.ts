import { describe, expect, it, vi } from "vitest";
import { mapRdapStatus, rdapCheck } from "./rdap.ts";

const res = (status: number) => new Response(null, { status });

describe("rdap", () => {
  it("maps status codes", () => {
    expect(mapRdapStatus(200)).toBe("taken");
    expect(mapRdapStatus(404)).toBe("free");
    expect(mapRdapStatus(429)).toBe("unknown");
    expect(mapRdapStatus(503)).toBe("unknown");
  });
  it("uses the right endpoint per TLD", async () => {
    const f = vi.fn(async (_u: string) => res(404));
    expect(await rdapCheck("foo.de", "de", f as unknown as typeof fetch)).toBe("free");
    expect(await rdapCheck("foo.com", "com", f as unknown as typeof fetch)).toBe("free");
    expect(f.mock.calls[0][0]).toBe("https://rdap.denic.de/domain/foo.de");
    expect(f.mock.calls[1][0]).toBe("https://rdap.verisign.com/com/v1/domain/foo.com");
  });
  it("returns unknown on network error", async () => {
    const f = vi.fn(async () => { throw new Error("boom"); });
    expect(await rdapCheck("foo.de", "de", f as unknown as typeof fetch)).toBe("unknown");
  });
});
