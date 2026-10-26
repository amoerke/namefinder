import type { CheckUpdateEvent } from '../../shared/types.ts';

type Listener = (ev: CheckUpdateEvent) => void;

export class EventHub {
  private readonly listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  broadcast(ev: CheckUpdateEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* einzelne kaputte Verbindung ignorieren */
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
