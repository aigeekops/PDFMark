import type { DocMeta, Mark } from '../types';

/**
 * Everything lives in IndexedDB on the user's machine. No network call ever
 * touches the document or the annotations.
 */

const DB_NAME = 'pdfmark';
const DB_VERSION = 2;
const STORE_DOCS = 'docs';
const STORE_MARKS = 'marks';

export interface StoredDoc extends DocMeta {
  data: ArrayBuffer;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_DOCS)) {
        db.createObjectStore(STORE_DOCS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_MARKS)) {
        const marks = db.createObjectStore(STORE_MARKS, { keyPath: 'id' });
        marks.createIndex('byDoc', 'docId', { unique: false });
        marks.createIndex('byPage', ['docId', 'page'], { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putDoc(doc: StoredDoc): Promise<void> {
  await tx(STORE_DOCS, 'readwrite', (s) => s.put(doc) as IDBRequest<IDBValidKey>);
}

export async function getDoc(id: string): Promise<StoredDoc | undefined> {
  return tx<StoredDoc | undefined>(STORE_DOCS, 'readonly', (s) => s.get(id) as IDBRequest<StoredDoc | undefined>);
}

export async function listDocs(): Promise<DocMeta[]> {
  const docs = await tx<StoredDoc[]>(STORE_DOCS, 'readonly', (s) => s.getAll() as IDBRequest<StoredDoc[]>);
  return docs
    .map(({ data: _data, ...meta }) => meta)
    .sort((a, b) => b.addedAt - a.addedAt);
}

export async function deleteDoc(id: string): Promise<void> {
  await tx(STORE_DOCS, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_MARKS, 'readwrite');
    const store = t.objectStore(STORE_MARKS);
    const idx = store.index('byDoc');
    const req = idx.getAllKeys(id);
    req.onsuccess = () => {
      for (const key of req.result) store.delete(key);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function putMark(mark: Mark): Promise<void> {
  await tx(STORE_MARKS, 'readwrite', (s) => s.put(mark) as IDBRequest<IDBValidKey>);
}

export async function deleteMark(id: string): Promise<void> {
  await tx(STORE_MARKS, 'readwrite', (s) => s.delete(id) as IDBRequest<undefined>);
}

export async function listMarks(docId: string): Promise<Mark[]> {
  const marks = await tx<Mark[]>(STORE_MARKS, 'readonly', (s) =>
    s.index('byDoc').getAll(docId) as IDBRequest<Mark[]>,
  );
  return marks.sort((a, b) => a.page - b.page || a.rects[0]?.y - b.rects[0]?.y || a.createdAt - b.createdAt);
}

/** Wholesale replace — used when importing a JSON backup. */
export async function replaceMarks(docId: string, marks: Mark[]): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE_MARKS, 'readwrite');
    const store = t.objectStore(STORE_MARKS);
    const req = store.index('byDoc').getAllKeys(docId);
    req.onsuccess = () => {
      for (const key of req.result) store.delete(key);
      for (const mark of marks) store.put(mark);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** Cheap content fingerprint so re-opening the same file restores its marks. */
export async function hashFile(file: File | ArrayBuffer): Promise<string> {
  const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf.slice(0, 2 * 1024 * 1024));
  const sizePart = buf.byteLength.toString(36);
  const hashPart = Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${sizePart}-${hashPart}`;
}
