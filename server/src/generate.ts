import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { GenerateRequest } from '../../shared/types.ts';

export const GenerateRequestSchema = z.object({
  description: z.string().trim().min(3, 'Bitte beschreibe kurz, was die Firma macht.').max(2000),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  language: z.enum(['de', 'en', 'international']).default('international'),
  styles: z.array(z.enum(['kunstwort', 'beschreibend', 'kombination', 'metapher'])).min(1, 'Bitte mindestens einen Stil wählen.'),
  maxLength: z.number().int().min(3).max(30).default(14),
  count: z.union([z.literal(10), z.literal(20), z.literal(30)]).default(20),
  mustInclude: z.string().trim().max(200).default(''),
  exclude: z.string().trim().max(200).default(''),
  provider: z.enum(['anthropic', 'openai']).optional(),
});

export interface GeneratedName {
  name: string;
  parts: string[];
  rationale: string;
}

const OutputSchema = z.object({
  names: z.array(z.object({ name: z.string(), parts: z.array(z.string()), rationale: z.string() })),
});

export class GenerationError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const STYLE_TEXT: Record<GenerateRequest['styles'][number], string> = {
  kunstwort: 'Kunstwörter (frei erfunden, gut aussprechbar)',
  beschreibend: 'beschreibende Namen (sagen direkt, was die Firma tut)',
  kombination: 'Kombinationen aus zwei Wörtern oder Wortteilen',
  metapher: 'Metaphern (Bilder/Begriffe, die die Idee symbolisieren)',
};

const LANG_TEXT: Record<GenerateRequest['language'], string> = {
  de: 'deutsch klingend',
  en: 'englisch klingend',
  international: 'international verständlich und in mehreren Sprachen gut aussprechbar',
};

export const SYSTEM_PROMPT = `Du bist eine erfahrene Namensagentur und entwickelst Firmen- und Markennamen für den deutschsprachigen Markt.

Regeln für jeden Namen (strikt einhalten):
- Nur Buchstaben A–Z/a–z und Ziffern. KEINE Umlaute (ä, ö, ü, ß – stattdessen ae/oe/ue/ss oder ein anderes Wort), KEINE Bindestriche, KEINE Leerzeichen, KEINE Sonderzeichen.
- Schreibweise in CamelCase: jede Wortgrenze beginnt mit einem Großbuchstaben (z. B. "SonnenPlan"). Einzelwörter ohne Wortgrenze sind genauso willkommen (z. B. "Lumora", "Leuchtturm").
- "parts" enthält die Wortbestandteile in genau dieser Schreibweise; zusammengesetzt ergeben sie exakt "name" (z. B. ["Sonnen", "Plan"]). Ein Einzelwort oder Kunstwort ohne Wortgrenze hat genau einen Teil (z. B. ["Lumora"]).
- Die maximale Länge des Namens (Zeichenanzahl) wird nie überschritten.
- Keine bekannten Marken, Firmennamen oder geschützten Produktnamen und nichts, was ihnen zum Verwechseln ähnlich ist.
- Namen müssen sich deutlich voneinander unterscheiden; keine Dubletten.
- "rationale": genau ein kurzer Satz auf Deutsch, warum der Name passt.
- Vorgegebene Musswörter sollen in jedem Namen (ggf. als Wortteil) vorkommen; Ausschlusswörter dürfen nie vorkommen.

Antworte ausschließlich im vorgegebenen JSON-Format.`;

export function buildUserPrompt(req: GenerateRequest): string {
  const lines = [
    `Beschreibung der Firma: ${req.description}`,
    req.tags.length ? `Stichworte: ${req.tags.join(', ')}` : null,
    `Sprache/Klang: ${LANG_TEXT[req.language]}`,
    `Stile (gemischt): ${req.styles.map((s) => STYLE_TEXT[s]).join('; ')}`,
    // Ohne diesen Hinweis liefern die Modelle fast nur zusammengesetzte Namen.
    req.styles.some((s) => s !== 'kombination')
      ? 'Mischung: Mindestens ein Drittel der Namen sind Einzelwörter (genau ein Teil), z. B. Kunstwörter oder Metaphern.'
      : null,
    `Maximale Länge: ${req.maxLength} Zeichen`,
    req.mustInclude ? `Musswörter: ${req.mustInclude}` : null,
    req.exclude ? `Ausschlusswörter: ${req.exclude}` : null,
    `Anzahl: Liefere ${Math.min(req.count + 5, 40)} Namen (einige mehr als die gewünschten ${req.count}, da ungültige aussortiert werden).`,
  ];
  return lines.filter(Boolean).join('\n');
}

function splitWords(list: string): string[] {
  return list
    .split(/[,;\n]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** Serverseitige Nachfilterung: Zeichensatz, Länge, Dubletten, Ausschlusswörter, parts-Konsistenz. */
export function filterNames(raw: GeneratedName[], req: Pick<GenerateRequest, 'maxLength' | 'count' | 'exclude'>): GeneratedName[] {
  const excluded = splitWords(req.exclude);
  const seen = new Set<string>();
  const out: GeneratedName[] = [];
  for (const item of raw) {
    const name = item.name.trim();
    if (!/^[A-Za-z0-9]+$/.test(name)) continue;
    if (name.length < 2 || name.length > req.maxLength) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    if (excluded.some((w) => key.includes(w))) continue;
    seen.add(key);
    let parts = item.parts.map((p) => p.trim()).filter(Boolean);
    if (parts.join('') !== name || parts.some((p) => !/^[A-Za-z0-9]+$/.test(p))) parts = [name];
    out.push({ name, parts, rationale: item.rationale.trim() });
    if (out.length >= req.count) break;
  }
  return out;
}

export type NameGenerator = (req: GenerateRequest) => Promise<GeneratedName[]>;

interface GeneratorOptions {
  apiKey: string | undefined;
  model: string;
  /** Nur für Tests: ersetzt den HTTP-Client des SDK. */
  fetch?: typeof fetch;
}

/** Gemeinsame Nachbearbeitung beider Anbieter. */
function finish(parsed: { names: GeneratedName[] } | null | undefined, req: GenerateRequest, truncated: boolean): GeneratedName[] {
  if (parsed == null) {
    const hint = truncated ? ' (Antwort zu lang – weniger Namen anfordern)' : '';
    throw new GenerationError(`Die KI-Antwort konnte nicht gelesen werden${hint}. Bitte erneut versuchen.`, 502);
  }
  const names = filterNames(parsed.names, req);
  if (names.length === 0) throw new GenerationError('Es kamen keine gültigen Namen zurück. Bitte Vorgaben lockern (z. B. Länge).', 422);
  return names;
}

const REFUSED = () => new GenerationError('Die KI hat diese Anfrage abgelehnt. Bitte Beschreibung umformulieren.', 422);

export function createAnthropicGenerator(opts: GeneratorOptions): NameGenerator {
  const client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey, fetch: opts.fetch, maxRetries: opts.fetch ? 0 : undefined }) : null;
  return async (req) => {
    if (!client) throw new GenerationError('Claude ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt).', 503);
    let response;
    try {
      response = await client.messages.parse({
        model: opts.model,
        max_tokens: 16000,
        output_config: { effort: 'medium', format: zodOutputFormat(OutputSchema) },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(req) }],
      });
    } catch (err) {
      // Originalfehler fürs Server-Log; die Nutzermeldung unten ist bewusst vereinfacht.
      if (err instanceof Anthropic.APIError) console.error(`Claude-API-Fehler ${err.status ?? '?'} (request ${err.requestID ?? '?'}): ${err.message}`);
      else console.error('Claude-Aufruf fehlgeschlagen:', err);
      if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message))
        throw new GenerationError('Das Guthaben des Anthropic-API-Kontos ist aufgebraucht. Bitte in der Anthropic Console unter „Plans & Billing“ aufladen.', 503);
      if (err instanceof Anthropic.RateLimitError) throw new GenerationError('Claude ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.', 503);
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
        throw new GenerationError('Der Claude-Zugang ist falsch konfiguriert (API-Schlüssel prüfen).', 502);
      if (err instanceof Anthropic.APIConnectionError) throw new GenerationError('Claude ist nicht erreichbar. Bitte später erneut versuchen.', 502);
      if (err instanceof Anthropic.InternalServerError) throw new GenerationError('Claude hat einen Fehler gemeldet. Bitte erneut versuchen.', 502);
      if (err instanceof Anthropic.BadRequestError) throw new GenerationError('Die Anfrage an die KI war ungültig. Bitte Eingaben prüfen.', 400);
      if (err instanceof Anthropic.APIError) throw new GenerationError(`KI-Fehler (${err.status ?? '?'}). Bitte erneut versuchen.`, 502);
      throw new GenerationError('Unerwarteter Fehler bei der Namensgenerierung.', 500);
    }
    if (response.stop_reason === 'refusal') throw REFUSED();
    return finish(response.parsed_output, req, response.stop_reason === 'max_tokens');
  };
}

export function createOpenAIGenerator(opts: GeneratorOptions): NameGenerator {
  const client = opts.apiKey ? new OpenAI({ apiKey: opts.apiKey, fetch: opts.fetch, maxRetries: opts.fetch ? 0 : undefined }) : null;
  return async (req) => {
    if (!client) throw new GenerationError('OpenAI ist nicht konfiguriert (OPENAI_API_KEY fehlt).', 503);
    let response;
    try {
      response = await client.responses.parse({
        model: opts.model,
        max_output_tokens: 16000,
        instructions: SYSTEM_PROMPT,
        input: buildUserPrompt(req),
        text: { format: zodTextFormat(OutputSchema, 'names') },
      });
    } catch (err) {
      if (err instanceof OpenAI.APIError) console.error(`OpenAI-API-Fehler ${err.status ?? '?'} (request ${err.requestID ?? '?'}): ${err.message}`);
      else console.error('OpenAI-Aufruf fehlgeschlagen:', err);
      if (err instanceof OpenAI.RateLimitError && err.code === 'insufficient_quota')
        throw new GenerationError('Das Guthaben des OpenAI-API-Kontos ist aufgebraucht. Bitte unter platform.openai.com bei „Billing“ aufladen.', 503);
      if (err instanceof OpenAI.RateLimitError) throw new GenerationError('OpenAI ist gerade ausgelastet. Bitte in einer Minute erneut versuchen.', 503);
      if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError)
        throw new GenerationError('Der OpenAI-Zugang ist falsch konfiguriert (API-Schlüssel prüfen).', 502);
      if (err instanceof OpenAI.APIConnectionError) throw new GenerationError('OpenAI ist nicht erreichbar. Bitte später erneut versuchen.', 502);
      if (err instanceof OpenAI.InternalServerError) throw new GenerationError('OpenAI hat einen Fehler gemeldet. Bitte erneut versuchen.', 502);
      if (err instanceof OpenAI.NotFoundError) throw new GenerationError(`Das OpenAI-Modell „${opts.model}“ ist nicht verfügbar (OPENAI_MODEL prüfen).`, 502);
      if (err instanceof OpenAI.BadRequestError) throw new GenerationError('Die Anfrage an die KI war ungültig. Bitte Eingaben prüfen.', 400);
      if (err instanceof OpenAI.APIError) throw new GenerationError(`KI-Fehler (${err.status ?? '?'}). Bitte erneut versuchen.`, 502);
      throw new GenerationError('Unerwarteter Fehler bei der Namensgenerierung.', 500);
    }
    const refused = response.output.some((item) => item.type === 'message' && item.content.some((c) => c.type === 'refusal'));
    if (refused) throw REFUSED();
    return finish(response.output_parsed, req, response.incomplete_details?.reason === 'max_output_tokens');
  };
}
