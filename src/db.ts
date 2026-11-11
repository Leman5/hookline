// Minimal promise wrapper over IndexedDB. One database, a few object stores keyed by string.
const DB_NAME = 'hookline';
const DB_VERSION = 1;
export type StoreName = 'tracks' | 'blobs' | 'analysis' | 'overrides' | 'kv';
const STORES: StoreName[] = ['tracks', 'blobs', 'analysis', 'overrides', 'kv'];

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: StoreName, mode: IDBTransactionMode): Promise<IDBObjectStore> {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function get<T>(name: StoreName, key: string): Promise<T | undefined> {
  return wrap((await store(name, 'readonly')).get(key)) as Promise<T | undefined>;
}

export async function put(name: StoreName, key: string, value: unknown): Promise<void> {
  await wrap((await store(name, 'readwrite')).put(value, key));
}

export async function del(name: StoreName, key: string): Promise<void> {
  await wrap((await store(name, 'readwrite')).delete(key));
}

export async function all<T>(name: StoreName): Promise<T[]> {
  return wrap((await store(name, 'readonly')).getAll()) as Promise<T[]>;
}

export async function putMany(name: StoreName, entries: [string, unknown][]): Promise<void> {
  const tx = (await open()).transaction(name, 'readwrite');
  const s = tx.objectStore(name);
  for (const [k, v] of entries) s.put(v, k);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
