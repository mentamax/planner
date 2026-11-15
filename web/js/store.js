// アプリの状態と保存（localStorage）。画面は subscribe で変更を受け取って描き直す。
import { today, mondayOf } from './dates.js';
import { buildDayIndex } from './model.js';
import { DEFAULT_CLIENT_ID } from './config.js';

// テストページ（tests.html）は別の保存先を使い、実データに触れない
const NS = globalThis.PLANNER_NS || 'planner';
const KEYS = {
  items: `${NS}.items.v1`,
  notes: `${NS}.notes.v1`,
  noteTimes: `${NS}.noteTimes.v1`,
  settings: `${NS}.settings.v1`,
  google: `${NS}.google.v1`,
  ui: `${NS}.ui.v1`,
};

const DEFAULT_SETTINGS = {
  clientId: '',
  weekStart: 1, // 1 = 月曜始まり, 0 = 日曜始まり
  hiddenCalendars: [],
  calendarsInitialized: false,
  defaultCalendarId: null,
  defaultTaskListId: null,
  accountHint: '',
  showEventsOnBoard: true,
};

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const savedGoogle = read(KEYS.google, {});
const savedUi = read(KEYS.ui, {});

export const state = {
  /** @type {import('./model.js').Item[]} */
  items: read(KEYS.items, []),
  /** @type {Record<string, string>} 'd:YYYY-MM-DD' = 日のメモ, 'w:YYYY-MM-DD'(月曜) = 週のメモ */
  notes: read(KEYS.notes, {}),
  /** メモごとの最終更新時刻（ミリ秒）。端末間の同期で「新しいほうを残す」ために使う。消したメモの時刻も残す */
  noteTimes: read(KEYS.noteTimes, {}),
  settings: { ...DEFAULT_SETTINGS, ...read(KEYS.settings, {}) },
  calendars: savedGoogle.calendars || [],
  taskLists: savedGoogle.taskLists || [],
  ui: { view: ['month', 'week', 'board'].includes(savedUi.view) ? savedUi.view : 'week', cursor: today() },
  auth: { status: 'disconnected', error: null }, // disconnected | connecting | connected | expired
  /** 同梱サーバーの認証 API の状態。{ hasSecret, connected, clientId, redirectUri } / API が無ければ null */
  backend: null,
  sync: { busy: false, lastSync: null, error: null, window: null, notesError: null },
};

if (!state.settings.clientId) state.settings.clientId = DEFAULT_CLIENT_ID;

// ---- 変更通知と保存 ----

const listeners = new Set();
const mutationHooks = new Set();
const dirty = new Set();
let version = 0;
let persistTimer = 0;

export const subscribe = fn => (listeners.add(fn), () => listeners.delete(fn));
/** アイテムがユーザー操作で変わったときに呼ばれる（同期の起点） */
export const onMutation = fn => mutationHooks.add(fn);

export function emit(...keys) {
  version++;
  keys.forEach(k => dirty.add(k));
  if (dirty.size) schedulePersist();
  listeners.forEach(fn => fn());
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 300);
}

export function persist() {
  clearTimeout(persistTimer);
  const write = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  try {
    if (dirty.has('notes')) {
      write(KEYS.notes, state.notes);
      write(KEYS.noteTimes, state.noteTimes);
    }
    if (dirty.has('settings')) write(KEYS.settings, state.settings);
    if (dirty.has('google')) write(KEYS.google, { calendars: state.calendars, taskLists: state.taskLists });
    if (dirty.has('ui')) write(KEYS.ui, { view: state.ui.view });
    if (dirty.has('items')) {
      try {
        write(KEYS.items, state.items);
      } catch {
        // 容量超過時は、Google から再取得できない未送信分だけを確実に残す
        write(KEYS.items, state.items.filter(i => i.sync !== 'synced'));
      }
    }
    dirty.clear();
  } catch (e) {
    console.error('保存に失敗しました', e);
  }
}

window.addEventListener('pagehide', persist);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persist();
});

// ---- 参照 ----

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
export const findItem = id => state.items.find(i => i.id === id);

export function visibleItems() {
  const hidden = new Set(state.settings.hiddenCalendars);
  return state.items.filter(i => i.sync !== 'delete' && !(i.kind === 'event' && i.google && hidden.has(i.google.containerId)));
}

let indexCache = { version: -1, map: new Map() };
function dayIndex() {
  if (indexCache.version !== version) indexCache = { version, map: buildDayIndex(visibleItems()) };
  return indexCache.map;
}

export const itemsOn = date => dayIndex().get(date) || [];
export const eventsOn = date => itemsOn(date).filter(i => i.kind === 'event');
export const tasksOn = date => itemsOn(date).filter(i => i.kind === 'task');

const byDone = (a, b) => (a.done === b.done ? (a.createdAt || 0) - (b.createdAt || 0) : a.done ? 1 : -1);
export const undatedTasks = () => visibleItems().filter(i => i.kind === 'task' && !i.date).sort(byDone);
export const overdueTasks = () => {
  const t = today();
  return visibleItems()
    .filter(i => i.kind === 'task' && !i.done && i.date && i.date < t)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
};
export const pendingCount = () => state.items.filter(i => i.sync !== 'synced').length;

// ---- アイテムの変更 ----

function changed() {
  emit('items');
  mutationHooks.forEach(fn => fn());
}

const touch = item => {
  item.updatedAt = Math.max(Date.now(), (item.updatedAt || 0) + 1);
};

export function createItem(fields) {
  const now = Date.now();
  const item = {
    kind: 'task',
    title: '',
    description: '',
    date: null,
    endDate: null,
    startTime: null,
    endTime: null,
    done: false,
    color: null,
    readOnly: false,
    ...fields,
    id: uid(),
    sync: 'create',
    createdAt: now,
    updatedAt: now,
  };
  state.items.push(item);
  changed();
  return item;
}

export function updateItem(id, patch) {
  const item = findItem(id);
  if (!item || item.readOnly) return;
  Object.assign(item, patch);
  touch(item);
  if (item.sync === 'synced') item.sync = 'update';
  changed();
}

export const toggleDone = id => {
  const item = findItem(id);
  if (item) updateItem(id, { done: !item.done });
};

/** 削除する。元に戻せるよう、削除前の内容を返す */
export function deleteItem(id) {
  const idx = state.items.findIndex(i => i.id === id);
  if (idx === -1) return null;
  const item = state.items[idx];
  const snapshot = { ...item };
  if (item.google) {
    item.sync = 'delete'; // Google 側の削除が済むまで残しておく
    touch(item);
  } else {
    state.items.splice(idx, 1);
  }
  changed();
  return snapshot;
}

export function restoreItem(snapshot) {
  const current = findItem(snapshot.id);
  if (current) {
    Object.assign(current, snapshot, { sync: snapshot.sync === 'synced' ? 'update' : snapshot.sync });
    touch(current);
  } else {
    // すでに Google からも消えているので、新しいアイテムとして作り直す
    const { google, ...rest } = snapshot;
    state.items.push({ ...rest, target: google?.containerId, sync: 'create', updatedAt: Date.now() });
  }
  changed();
}

// ---- メモ ----

export const dayNoteKey = date => `d:${date}`;
export const weekNoteKey = date => `w:${mondayOf(date, state.settings.weekStart)}`;
export const hasNote = key => !!state.notes[key]?.trim();

// 時刻の記録がなかった頃のメモには、いまの時刻を付ける（同期で古い扱いにされて消えないように）
for (const key of Object.keys(state.notes)) {
  if (!state.noteTimes[key]) {
    state.noteTimes[key] = Date.now();
    dirty.add('notes');
  }
}
if (dirty.size) schedulePersist();

const noteHooks = new Set();
/** メモが編集されたときに呼ばれる（端末間同期の起点） */
export const onNoteChange = fn => noteHooks.add(fn);

/** 入力のたびに呼ぶ。入力中の欄を描き直さないよう、画面には通知しない */
export function setNote(key, text) {
  if (text.trim()) state.notes[key] = text;
  else delete state.notes[key];
  state.noteTimes[key] = Math.max(Date.now(), (state.noteTimes[key] || 0) + 1);
  dirty.add('notes');
  schedulePersist();
  noteHooks.forEach(fn => fn());
}

/** 他の端末で書かれた、より新しいメモを取り込む。incoming は [キー, 本文, 更新時刻] の一覧 */
export function applyRemoteNotes(incoming) {
  if (!incoming.length) return;
  for (const [key, text, time] of incoming) {
    if (text.trim()) state.notes[key] = text;
    else delete state.notes[key];
    state.noteTimes[key] = time;
  }
  emit('notes');
}

// ---- 表示と設定 ----

export function setView(view) {
  state.ui.view = view;
  emit('ui');
}

export function setCursor(date) {
  state.ui.cursor = date;
  emit();
}

export function updateSettings(patch) {
  Object.assign(state.settings, patch);
  emit('settings');
}

// ---- バックアップ ----

export function exportData() {
  const { clientId, accountHint, ...settings } = state.settings;
  return {
    app: 'planner',
    version: 1,
    exportedAt: new Date().toISOString(),
    notes: state.notes,
    settings,
    items: state.items.filter(i => !i.google && i.sync !== 'delete'),
  };
}

export function importData(data) {
  if (!data || data.app !== 'planner') throw new Error('Planner のバックアップファイルではありません');
  const notes = Object.entries(data.notes || {}).filter(([k, v]) => /^[dw]:\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'string');
  Object.assign(state.notes, Object.fromEntries(notes));
  for (const [key] of notes) state.noteTimes[key] = Date.now();
  const existing = new Set(state.items.map(i => i.id));
  let added = 0;
  for (const raw of data.items || []) {
    if (!raw || typeof raw.title !== 'string' || existing.has(raw.id)) continue;
    const { google, target, ...rest } = raw;
    state.items.push({ ...rest, kind: raw.kind === 'event' ? 'event' : 'task', id: raw.id || uid(), sync: 'create' });
    added++;
  }
  emit('notes', 'items');
  mutationHooks.forEach(fn => fn());
  noteHooks.forEach(fn => fn());
  return { notes: notes.length, items: added };
}
