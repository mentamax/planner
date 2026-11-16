// 手書きメモの保存。線の点列は大きくなるので、localStorage ではなく IndexedDB に置く。
// 目次（どのメモに手書きがあるか・いつ更新したか）だけは store.js の state.ink に持つ。
import { emit, setInkMeta } from './store.js';

export const PAGE_W = 1000; // ページ幅の基準。座標はすべてこの幅に対する値
export const PAGE_H = 1300; // 新しいページの高さ
export const PAGE_H_MAX = 5200;

const DB_NAME = `${globalThis.PLANNER_NS || 'planner'}-ink`;
let dbPromise = null;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('ink', { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('ink', mode);
    const req = fn(tx.objectStore('ink'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const cache = new Map(); // キー → 手書きデータ / 無ければ null
const loading = new Set();
const remoteHooks = new Set();

/** 他の端末から届いた手書きを取り込んだときに呼ばれる（開いているページの描き直し用） */
export const onRemoteInk = fn => remoteHooks.add(fn);

export const blankInk = key => ({ key, u: 0, h: PAGE_H, strokes: [] });

function valid(doc) {
  return !!doc && typeof doc.key === 'string' && Array.isArray(doc.strokes) && doc.strokes.every(s => Array.isArray(s?.p));
}

export async function loadInk(key) {
  if (cache.has(key)) return cache.get(key);
  let doc = null;
  try {
    doc = (await run('readonly', s => s.get(key))) || null;
  } catch {
    doc = null; // 保存領域が使えないブラウザでは、手書きなしとして扱う
  }
  cache.set(key, valid(doc) ? doc : null);
  return cache.get(key);
}

/** 画面の描画中に使う。読み込み済みならデータ（無ければ null）、まだなら undefined を返して裏で読み込む */
export function cachedInk(key) {
  if (cache.has(key)) return cache.get(key);
  if (!loading.has(key)) {
    loading.add(key);
    loadInk(key).finally(() => {
      loading.delete(key);
      emit();
    });
  }
  return undefined;
}

/** 保存する。fromRemote = 他の端末から届いた分 */
export async function saveInk(doc, { fromRemote = false } = {}) {
  if (!valid(doc)) return;
  const clean = { key: doc.key, u: doc.u, h: Math.min(Math.max(Number(doc.h) || PAGE_H, PAGE_H), PAGE_H_MAX), strokes: doc.strokes };
  cache.set(clean.key, clean);
  setInkMeta(clean.key, { u: clean.u, n: clean.strokes.length }, fromRemote);
  try {
    await run('readwrite', s => s.put(clean));
  } catch (e) {
    console.error('手書きを保存できませんでした', e);
  }
  if (fromRemote) remoteHooks.forEach(fn => fn(clean));
}
