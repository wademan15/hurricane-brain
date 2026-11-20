import type { DeviceEventName, DeviceEvents, Listener } from './types';

/** Minimal typed event emitter. Listener errors are isolated so one bad listener cannot stop decoding. */
export class Emitter {
  private listeners = new Map<DeviceEventName, Set<(e: never) => void>>();

  on<K extends DeviceEventName>(type: K, listener: Listener<K>): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as (e: never) => void);
    return () => set.delete(listener as (e: never) => void);
  }

  emit<K extends DeviceEventName>(type: K, event: DeviceEvents[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const l of [...set]) {
      try {
        (l as Listener<K>)(event);
      } catch (err) {
        if (type !== 'error') this.emit('error', { slot: null, message: `listener for ${type} threw: ${String(err)}` });
      }
    }
  }
}
