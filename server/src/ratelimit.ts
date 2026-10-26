const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type LimitResult =
  | { ok: true; release: () => void }
  | { ok: false; error: string; retryAfterS: number };

function fmtWait(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  return min >= 60 ? `${Math.ceil(min / 60)} Stunde(n)` : `${min} Minute(n)`;
}

function removeOne(arr: number[], t: number): void {
  const i = arr.indexOf(t);
  if (i !== -1) arr.splice(i, 1);
}

/**
 * Begrenzt LLM-Generierungen: sliding window pro Session und Stunde
 * plus globales rollierendes 24-h-Limit über alle Sessions.
 * reserve() prüft und belegt atomar einen Slot; release() gibt ihn bei Fehlschlag frei.
 */
export class GenerationLimiter {
  private readonly perHour: number;
  private readonly perDay: number;
  private readonly sessions = new Map<string, number[]>();
  private global: number[];

  constructor(perHour: number, perDay: number, initialGlobal: number[] = []) {
    this.perHour = perHour;
    this.perDay = perDay;
    this.global = [...initialGlobal].sort((a, b) => a - b);
  }

  reserve(sessionId: string, now = Date.now()): LimitResult {
    this.global = this.global.filter((t) => now - t < DAY);
    if (this.global.length >= this.perDay) {
      const wait = this.global[0]! + DAY - now;
      return { ok: false, error: `Das Tageslimit von ${this.perDay} Generierungen ist erreicht. Bitte in ${fmtWait(wait)} erneut versuchen.`, retryAfterS: Math.ceil(wait / 1000) };
    }
    const mine = (this.sessions.get(sessionId) ?? []).filter((t) => now - t < HOUR);
    this.sessions.set(sessionId, mine);
    if (mine.length >= this.perHour) {
      const wait = mine[0]! + HOUR - now;
      return { ok: false, error: `Du hast das Limit von ${this.perHour} Generierungen pro Stunde erreicht. Bitte in ${fmtWait(wait)} erneut versuchen.`, retryAfterS: Math.ceil(wait / 1000) };
    }
    this.global.push(now);
    mine.push(now);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        removeOne(this.global, now);
        removeOne(this.sessions.get(sessionId) ?? [], now);
      },
    };
  }
}
