const DATABASE_NAME = 'spotify-canonicalizer';
const DATABASE_VERSION = 1;
const STORE_NAME = 'playlist-scan-cache';
const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true });
    request.addEventListener('error', () => reject(request.error || new Error('Local scan cache request failed.')), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', resolve, { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error || new Error('Local scan cache transaction was aborted.')), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error || new Error('Local scan cache transaction failed.')), { once: true });
  });
}

function cacheKey(accountId, playlistId) {
  return `${accountId}::${playlistId}`;
}

async function openDatabase() {
  if (!globalThis.indexedDB) throw new Error('This browser does not support resumable scan storage.');
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener('upgradeneeded', () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' });
  }, { once: true });
  return requestResult(request);
}

export class PlaylistScanCache {
  constructor() {
    this.databasePromise = null;
  }

  database() {
    if (!this.databasePromise) this.databasePromise = openDatabase();
    return this.databasePromise;
  }

  async get(accountId, playlistId, snapshotId) {
    if (!accountId || !playlistId || !snapshotId) return null;
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const record = await requestResult(transaction.objectStore(STORE_NAME).get(cacheKey(accountId, playlistId)));
    await transactionComplete(transaction);
    const savedAt = Date.parse(record?.savedAt || '');
    if (record?.schemaVersion !== 1 || record.snapshotId !== snapshotId || !Array.isArray(record.items) ||
        !Number.isFinite(savedAt) || Date.now() - savedAt > MAX_CACHE_AGE_MS) {
      if (record) await this.delete(accountId, playlistId).catch(() => {});
      return null;
    }
    return record.items;
  }

  async delete(accountId, playlistId) {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(cacheKey(accountId, playlistId));
    await transactionComplete(transaction);
  }

  async put(accountId, playlistId, snapshotId, items) {
    if (!accountId || !playlistId || !snapshotId || !Array.isArray(items)) return;
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put({
      key: cacheKey(accountId, playlistId),
      schemaVersion: 1,
      snapshotId,
      items,
      savedAt: new Date().toISOString(),
    });
    await transactionComplete(transaction);
  }

  async clearAll() {
    const database = await this.database();
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    await transactionComplete(transaction);
  }
}
