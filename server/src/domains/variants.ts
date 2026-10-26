import { toLabel } from "./normalize.ts";

export interface Variant {
  name: string;
  parts: string[];
}

const MAX_LEN = 20;
const PREFIXES_EN = ["Get", "My", "Go", "Try"];
const SUFFIXES_EN = ["HQ", "Labs", "Group", "io", "ly", "ify", "Hub", "Works"];
const PREFIXES_DE = ["Mein", "Team"];
const SUFFIXES_DE = ["Werk", "Haus", "Hof", "Kontor", "Manufaktur", "Team", "Gruppe"];

export type VariantLanguage = "de" | "en" | "international";
const VOWELS = "aeiou";

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** Brand-safe: transliterate umlauts, drop everything but letters/digits, keep casing. */
function clean(s: string): string {
  return s
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss")
    .replace(/[^A-Za-z0-9]/g, "");
}

export function generateVariants(name: string, parts: string[], language: VariantLanguage = "en"): Variant[] {
  const PREFIXES = language === "de" ? PREFIXES_DE : PREFIXES_EN;
  const SUFFIXES = language === "de" ? SUFFIXES_DE : SUFFIXES_EN;
  const base = clean(name);
  let p = parts.map(clean).filter(Boolean);
  if (p.length === 0) p = [base];
  const out: Variant[] = [];
  const add = (vParts: string[]) => {
    const ps = vParts.map(clean).filter(Boolean);
    out.push({ name: ps.join(""), parts: ps });
  };

  for (const pre of PREFIXES) add([pre, ...p]);
  for (const suf of SUFFIXES) {
    if (/^[a-z]/.test(suf)) {
      // glued suffixes (io, ly, ify) become part of the last word
      const last = p[p.length - 1];
      const stem = suf !== "io" && VOWELS.includes(last.slice(-1).toLowerCase()) ? last.slice(0, -1) : last;
      add([...p.slice(0, -1), stem + suf]);
    } else add([...p, suf]);
  }
  if (p.length >= 2) add([...p].reverse().map(cap));
  const last = p[p.length - 1];
  const end = last.slice(-1).toLowerCase();
  if (VOWELS.includes(end)) {
    for (const v of ["a", "o", "i"]) if (v !== end) add([...p.slice(0, -1), last.slice(0, -1) + v]);
  } else {
    for (const v of ["a", "o"]) add([...p.slice(0, -1), last + v]);
  }

  const seen = new Set([toLabel(base)]);
  return out.filter((v) => {
    const key = toLabel(v.name);
    if (!key || v.name.length > MAX_LEN || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
