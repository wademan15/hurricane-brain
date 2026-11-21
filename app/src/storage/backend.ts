/**
 * Key-value storage backends. `IdbBackend` is the real one (IndexedDB, this browser only).
 * `MemoryBackend` has the same behaviour for tests (values are structured-cloned on the way in
 * and out, as IndexedDB does).
 */
export type StoreName = 'recordings' | 'recordingMeta' | 'sessions' | 'profiles' | 'settings';
export const STORE_NAMES: StoreName[] = ['recordings', 'recordingMeta', 'sessions', 'profiles', 'settings'];

export interface KvBackend {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  getAll<T>(store: StoreName): Promise<T[]>;
  keys(store: StoreName): Promise<string[]>;
  clearAll(): Promise<void>;
}

export class MemoryBackend implements KvBackend {
  private readonly data = new Map<StoreName, Map<string, unknown>>();

  private store(s: StoreName): Map<string, unknown> {
    let m = this.data.get(s);
    if (!m) {
      m = new Map();
      this.data.set(s, m);
    }
    return m;
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const v = this.store(store).get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
  async put(store: StoreName, key: string, value: unknown): Promise<void> {
    this.store(store).set(key, structuredClone(value));
  }
  async delete(store: StoreName, key: string): Promise<void> {
    this.store(store).delete(key);
  }
  async getAll<T>(store: StoreName): Promise<T[]> {
    return [...this.store(store).values()].map((v) => structuredClone(v) as T);
  }
  async keys(store: StoreName): Promise<string[]> {
    return [...this.store(store).keys()];
  }
  async clearAll(): Promise<void> {
    this.data.clear();
  }
}

const DB_NAME = 'hurricane-brain';
const DB_VERSION = 1;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IdbBackend implements KvBackend {
  private dbp: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = () => {
          const db = open.result;
          for (const s of STORE_NAMES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error ?? new Error('could not open the local database'));
        open.onblocked = () => reject(new Error('the local database is open in another tab'));
      });
    }
    return this.dbp;
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const db = await this.db();
    return (await req(db.transaction(store).objectStore(store).get(key))) as T | undefined;
  }
  async put(store: StoreName, key: string, value: unknown): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    await txDone(tx);
  }
  async delete(store: StoreName, key: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    await txDone(tx);
  }
  async getAll<T>(store: StoreName): Promise<T[]> {
    const db = await this.db();
    return (await req(db.transaction(store).objectStore(store).getAll())) as T[];
  }
  async keys(store: StoreName): Promise<string[]> {
    const db = await this.db();
    return (await req(db.transaction(store).objectStore(store).getAllKeys())).map(String);
  }
  async clearAll(): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(STORE_NAMES, 'readwrite');
    for (const s of STORE_NAMES) tx.objectStore(s).clear();
    await txDone(tx);
  }
}
