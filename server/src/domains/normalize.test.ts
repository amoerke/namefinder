import { describe, expect, it } from "vitest";
import { hyphenLabel, toLabel } from "./normalize.ts";

describe("toLabel", () => {
  it("lowercases and transliterates umlauts", () => {
    expect(toLabel("GrünÖlStraße")).toBe("gruenoelstrasse");
  });
  it("strips non a-z0-9 and caps at 63", () => {
    expect(toLabel("Foo-Bar 2!")).toBe("foobar2");
    expect(toLabel("a".repeat(80))).toHaveLength(63);
  });
});

describe("hyphenLabel", () => {
  it("joins normalized parts", () => {
    expect(hyphenLabel(["Sonnen", "Plän"])).toBe("sonnen-plaen");
  });
  it("returns null for <2 parts", () => {
    expect(hyphenLabel(["Solo"])).toBeNull();
    expect(hyphenLabel(["Solo", "!!"])).toBeNull();
    expect(hyphenLabel([])).toBeNull();
  });
});
