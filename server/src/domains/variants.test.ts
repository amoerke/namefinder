import { describe, expect, it } from "vitest";
import { generateVariants } from "./variants.ts";

describe("generateVariants", () => {
  const vs = generateVariants("SonnenPlan", ["Sonnen", "Plan"]);
  it("produces 10-15 unique variants without the original", () => {
    expect(vs.length).toBeGreaterThanOrEqual(10);
    expect(vs.length).toBeLessThanOrEqual(16);
    const labels = vs.map((v) => v.name.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain("sonnenplan");
  });
  it("contains expected rule types with consistent parts", () => {
    const names = vs.map((v) => v.name);
    expect(names).toContain("GetSonnenPlan");
    expect(names).toContain("SonnenPlanHQ");
    expect(names).toContain("PlanSonnen");
    for (const v of vs) {
      expect(v.parts.join("")).toBe(v.name);
      expect(v.name).toMatch(/^[A-Za-z0-9]+$/);
      expect(v.name.length).toBeLessThanOrEqual(20);
    }
  });
  it("removes umlauts and respects max length", () => {
    const long = generateVariants("Grünwaldmeister", ["Grünwald", "meister"]);
    for (const v of long) {
      expect(v.name).not.toMatch(/[äöüß]/i);
      expect(v.name.length).toBeLessThanOrEqual(20);
    }
  });

  it("uses German affixes for language de", () => {
    const names = generateVariants("SonnenPlan", ["Sonnen", "Plan"], "de").map((v) => v.name);
    expect(names).toContain("MeinSonnenPlan");
    expect(names).toContain("SonnenPlanWerk");
    expect(names).toContain("SonnenPlanKontor");
    expect(names).not.toContain("GetSonnenPlan");
  });
  it("en/international match the default", () => {
    const def = generateVariants("SonnenPlan", ["Sonnen", "Plan"]);
    expect(generateVariants("SonnenPlan", ["Sonnen", "Plan"], "en")).toEqual(def);
    expect(generateVariants("SonnenPlan", ["Sonnen", "Plan"], "international")).toEqual(def);
  });
});
