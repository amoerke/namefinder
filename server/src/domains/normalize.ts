export const TLDS = ["de", "com"] as const;
export type Tld = (typeof TLDS)[number];

const TRANSLIT: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", é: "e", è: "e", á: "a", à: "a" };

/** Turns a name fragment into lowercase ASCII letters/digits. */
export function toAscii(text: string): string {
  return text
    .toLowerCase()
    .replace(/[äöüßéèáà]/g, (ch) => TRANSLIT[ch] ?? ch)
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");
}

/** A DNS label that both DENIC and Verisign accept. */
export function isValidLabel(label: string): boolean {
  if (label.length < 1 || label.length > 63) return false;
  if (!/^[a-z0-9-]+$/.test(label)) return false;
  if (label.startsWith("-") || label.endsWith("-")) return false;
  // "xx--" is reserved for IDN/ACE prefixes.
  if (label.slice(2, 4) === "--") return false;
  return true;
}

export interface Labels {
  plain: string;
  /** Hyphenated at the word boundaries; null for single-part names. */
  hyphen: string | null;
}

export function labelsFor(parts: string[]): Labels | null {
  const clean = parts.map(toAscii).filter(Boolean);
  if (clean.length === 0) return null;
  const plain = clean.join("");
  if (!isValidLabel(plain)) return null;
  const hyphenated = clean.length > 1 ? clean.join("-") : null;
  return { plain, hyphen: hyphenated && isValidLabel(hyphenated) ? hyphenated : null };
}

export function domainsFor(label: string): string[] {
  return TLDS.map((tld) => `${label}.${tld}`);
}

export function tldOf(domain: string): Tld {
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld !== "de" && tld !== "com") throw new Error(`Nicht unterstützte TLD: ${domain}`);
  return tld;
}

/** Domain label for a brand name: lowercase ASCII a-z0-9, umlauts transliterated, max 63 chars. */
export function toLabel(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 63);
}

/** Hyphenated label from word parts ("sonnen-plan"); null if fewer than 2 non-empty parts. */
export function hyphenLabel(parts: string[]): string | null {
  const clean = parts.map(toLabel).filter(Boolean);
  if (clean.length < 2) return null;
  const label = clean.join("-");
  return label.length <= 63 ? label : null;
}
