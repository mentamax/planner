// Google との接続状態の管理と、双方向同期（未送信の変更を送る → Google の最新を取り込む）。
import * as g from './google.js';
import * as backend from './backend.js';
import { state, emit, persist, onMutation, onNoteChange, applyRemoteNotes, findItem } from './store.js';
import { mergeRemote, mergeNotes } from './model.js';
import { today, addDays, fromYMD } from './dates.js';

const AUTO_SYNC_MS = 5 * 60_000;

function setAuth(status, error = null) {
  state.auth = { status, error };
  emit();
}

function setSync(patch) {
  Object.assign(state.sync, patch);
  emit();
}

// ---- 接続 ----

let expiryTimer = 0;
function watchExpiry() {
  clearTimeout(expiryTimer);
  // ブラウザだけの方式では、トークンは約 1 時間で切れる。切れたら「再接続」を案内する
  // （その間の変更は手元に残り、再接続したときに送られる）
  const ms = g.tokenExpiresAt() - Date.now() - 30_000;
  expiryTimer = setTimeout(() => {
    if (usingBackend()) return;
    g.clearToken();
    setAuth('expired');
  }, Math.max(ms, 0));
}

/** サーバー方式で接続中か（同梱サーバーが更新用トークンを持っていて、切れても自動で取り直せる） */
export const usingBackend = () => !!state.backend?.connected;

/** サーバーからアクセストークンをもらう。更新用トークンが失効していたら再接続待ちにする */
async function serverToken() {
  try {
    return await backend.fetchToken();
  } catch (e) {
    if (e.code !== 'reauth') throw new Error(backend.AUTH_ERRORS[e.code] || `Google の認証を更新できませんでした（${e.message}）`);
    state.backend = { ...state.backend, connected: false };
    g.useTokenSource(null);
    throw new g.AuthError();
  }
}

/** シークレットを同梱サーバーに保存する（空文字なら保存済みの情報を消す） */
export async function saveSecret(clientId, clientSecret) {
  const wasBackend = usingBackend();
  state.backend = await backend.saveConfig(clientId, clientSecret);
  if (wasBackend && !state.backend.connected) return disconnect({ server: false });
  emit();
}

const RETURN_KEY = `${globalThis.PLANNER_NS || 'planner'}.returnTo`;

/**
 * ログイン後に戻るページ。控えておいたパスが、このサイト内の別ページを指しているときだけ返す
 * （外部サイトへ飛ばされないよう、「/」始まりのパス以外は受け付けない）。
 */
export function safeReturnPath(saved, currentPath) {
  if (typeof saved !== 'string' || !/^\/(?![/\\])/.test(saved) || saved.includes('\\')) return null;
  return saved.split(/[?#]/)[0] === currentPath ? null : saved;
}

/**
 * Google と接続する。どちらの方式も、ページごと Google のログイン画面へ移動して戻ってくる
 * （戻ってきたあとの処理は initSync）。
 */
export function connect() {
  const clientId = state.settings.clientId.trim();
  if (!state.backend?.hasSecret && !clientId) {
    setAuth('disconnected', 'OAuth クライアント ID を入力してください');
    return;
  }
  setAuth('connecting');
  persist(); // ページを離れる前に、書きかけの内容を確実に保存する
  // ログインはアプリのトップに戻ってくるので、いま開いているページ（今日の一覧など）を控えておく
  localStorage.setItem(RETURN_KEY, location.pathname + location.search);
  if (state.backend?.hasSecret) location.assign(backend.START_URL); // サーバー方式（接続を保てる）
  else g.beginLogin(clientId); // ブラウザだけの方式（約 1 時間）
}

/** 接続を外す。Google 側の予定やタスクには触れない */
export async function disconnect({ server = true } = {}) {
  clearTimeout(expiryTimer);
  if (server && usingBackend()) {
    try {
      state.backend = await backend.disconnect();
    } catch {
      state.backend = { ...state.backend, connected: false };
    }
  }
  g.useTokenSource(null);
  g.clearToken();
  // Google 由来で送信待ちのないものは手元から外す（Google には残る）。未送信のものは残す
  state.items = state.items.filter(i => i.sync !== 'synced');
  state.calendars = [];
  state.taskLists = [];
  Object.assign(state.settings, { accountHint: '', calendarsInitialized: false, hiddenCalendars: [], defaultCalendarId: null, defaultTaskListId: null });
  state.sync = { busy: false, lastSync: null, error: null, window: null, notesError: null };
  state.auth = { status: 'disconnected', error: null };
  emit('items', 'google', 'settings');
}

// ---- 同期 ----

// 同期の中身は 3 つ: push = 予定・タスクの未送信分を送る / pull = Google の最新を取り込む / notes = メモ
const FULL = { push: true, pull: true, notes: true };

let running = null;
let queued = null; // 実行中に来た依頼（やることの和集合）
let queuedDone = null; // 実行中の同期のあとに走る分が終わると解決する

/** 送信してから Google の最新を取り込む（メモも含む） */
export const syncNow = () => run(FULL);
/** 予定・タスクの未送信の変更だけを送る */
const pushNow = () => run({ push: true });
/** メモだけを同期する */
const notesNow = () => run({ notes: true });

function run(parts) {
  if (state.auth.status !== 'connected') return Promise.resolve();
  if (running) {
    // 実行中のものは今の変更を見ていないかもしれないので、終わったあとにもう一度走らせる。
    // 返す Promise は、その「あとの分」が終わるまで待つ
    queued = { ...queued, ...parts };
    queuedDone ??= running.then(() => {
      const next = queued;
      queued = null;
      queuedDone = null;
      return run(next);
    });
    return queuedDone;
  }
  running = doSync(parts).finally(() => (running = null));
  return running;
}

async function doSync({ push, pull: doPull, notes }) {
  setSync({ busy: true });
  try {
    let failures = [];
    if (push || doPull) {
      if (doPull || !state.taskLists.length) await refreshContainers();
      failures = await pushPending();
      if (doPull) await pull();
    }
    if (notes) await syncNotes();
    setSync({
      busy: false,
      error: failures.length ? `${failures.length} 件を Google に反映できませんでした: ${failures[0]}` : null,
      ...(doPull ? { lastSync: Date.now() } : {}),
    });
  } catch (e) {
    if (e instanceof g.AuthError) {
      state.sync.busy = false;
      setAuth('expired');
    } else {
      setSync({ busy: false, error: e.message || '同期に失敗しました' });
    }
  }
}

/**
 * メモを Google ドライブ（このアプリ専用の隠し領域）と突き合わせる。
 * メモの同期だけができない場合（許可が古い、Drive API が無効など）は、予定・タスクの同期は止めずに理由を記録する。
 */
async function syncNotes() {
  try {
    const file = await g.loadNotesFile();
    // 通信中に書かれた分も含めて、いまの手元の内容と突き合わせる
    const merged = mergeNotes({ notes: state.notes, times: state.noteTimes }, file.doc);
    applyRemoteNotes(merged.incoming);
    if (merged.upload) await g.saveNotesFile(file.id, merged.doc);
    if (state.sync.notesError) state.sync.notesError = null;
  } catch (e) {
    if (e instanceof g.AuthError) throw e;
    state.sync.notesError = e.status === 403 ? 'permission' : e.message || 'error';
  }
}

async function refreshContainers() {
  let calendars;
  try {
    calendars = await g.fetchCalendars();
  } catch (e) {
    if (e.status !== 403) throw e;
    // カレンダー一覧の権限がない場合はメインのカレンダーだけを使う
    calendars = [{ id: 'primary', name: 'マイカレンダー', color: null, primary: true, writable: true, selected: true }];
  }
  const taskLists = await g.fetchTaskLists();
  const s = state.settings;
  const primary = calendars.find(c => c.primary);

  if (!s.calendarsInitialized) {
    // 初回は Google カレンダーで表示オンにしているものだけを表示する
    s.hiddenCalendars = calendars.filter(c => !c.selected && !c.primary).map(c => c.id);
    s.calendarsInitialized = true;
  }
  if (primary?.id.includes('@')) s.accountHint = primary.id;
  if (!calendars.some(c => c.id === s.defaultCalendarId && c.writable)) {
    s.defaultCalendarId = (primary || calendars.find(c => c.writable))?.id || null;
  }
  if (!taskLists.some(l => l.id === s.defaultTaskListId)) s.defaultTaskListId = taskLists[0]?.id || null;

  state.calendars = calendars;
  state.taskLists = taskLists;
  emit('google', 'settings');
}

const gone = e => e.status === 404 || e.status === 410;

async function pushPending() {
  const failures = [];
  const pending = state.items.filter(i => i.sync !== 'synced').map(i => ({ ...i }));
  for (const snap of pending) {
    try {
      if (snap.sync === 'delete') {
        await remoteDelete(snap);
        afterDelete(snap);
      } else if (!snap.google) {
        afterPush(snap, await remoteCreate(snap));
      } else {
        try {
          await remoteUpdate(snap);
          afterPush(snap, snap.google);
        } catch (e) {
          if (!gone(e)) throw e;
          dropLocal(snap.id); // Google 側で削除済み
        }
      }
    } catch (e) {
      if (e instanceof g.AuthError) throw e;
      failures.push(`「${snap.title}」${e.message}`);
    }
  }
  emit('items');
  return failures;
}

async function remoteCreate(item) {
  if (item.kind === 'event') {
    const cal = item.target || state.settings.defaultCalendarId || 'primary';
    const ev = await g.insertEvent(cal, item);
    return { id: ev.id, containerId: cal, htmlLink: ev.htmlLink || '' };
  }
  const list = item.target || state.settings.defaultTaskListId || '@default';
  const t = await g.insertTask(list, item);
  return { id: t.id, containerId: list, htmlLink: t.webViewLink || '' };
}

const remoteUpdate = item =>
  item.kind === 'event'
    ? g.patchEvent(item.google.containerId, item.google.id, item)
    : g.patchTask(item.google.containerId, item.google.id, item);

async function remoteDelete(item) {
  if (!item.google) return;
  try {
    if (item.kind === 'event') await g.deleteEvent(item.google.containerId, item.google.id);
    else await g.deleteTask(item.google.containerId, item.google.id);
  } catch (e) {
    if (!gone(e)) throw e;
  }
}

function dropLocal(id) {
  const idx = state.items.findIndex(i => i.id === id);
  if (idx !== -1) state.items.splice(idx, 1);
}

/** 送信中にユーザーがさらに編集していた場合は、その分を次回に送る */
function afterPush(snap, ref) {
  const cur = findItem(snap.id);
  if (!cur) return;
  cur.google = { ...cur.google, ...ref };
  delete cur.target;
  if (cur.sync === 'delete') return;
  if (cur.kind === 'event' && !cur.color) cur.color = state.calendars.find(c => c.id === ref.containerId)?.color || null;
  cur.sync = cur.updatedAt === snap.updatedAt ? 'synced' : 'update';
}

function afterDelete(snap) {
  const cur = findItem(snap.id);
  if (!cur) return;
  if (cur.sync === 'delete') return dropLocal(snap.id);
  // 送信中に「元に戻す」された → Google からは消えたので作り直す
  cur.target = cur.google?.containerId;
  delete cur.google;
  cur.sync = 'create';
}

function wantedWindow() {
  const t = today();
  const c = state.ui.cursor;
  const lo = [addDays(t, -183), addDays(c, -62)].sort()[0];
  const hi = [addDays(t, 366), addDays(c, 62)].sort()[1];
  return { min: lo, max: hi };
}

async function pull() {
  const win = wantedWindow();
  const timeMin = fromYMD(win.min).toISOString();
  const timeMax = fromYMD(addDays(win.max, 1)).toISOString();
  const hidden = new Set(state.settings.hiddenCalendars);
  const failed = new Set();
  let authError = null;

  const guard = (id, promise) =>
    promise.catch(e => {
      if (e instanceof g.AuthError) authError = e;
      failed.add(id);
      return [];
    });

  const calendars = state.calendars.filter(c => !hidden.has(c.id));
  const [eventSets, taskSets] = await Promise.all([
    Promise.all(calendars.map(c => guard(c.id, g.fetchEvents(c, timeMin, timeMax)))),
    Promise.all(state.taskLists.map(l => guard(l.id, g.fetchTasks(l)))),
  ]);
  if (authError) throw authError;

  const recent = Date.now() - 30 * 86400_000;
  const tasks = taskSets.flat().filter(t => {
    if (!t.done) return true;
    return t.date ? t.date >= win.min : (t.completedAt || t.updatedAt) >= recent;
  });

  state.items = mergeRemote(state.items, [...eventSets.flat(), ...tasks], failed);
  state.sync.window = win;
  emit('items');
  if (failed.size) throw new Error(`${failed.size} 件のカレンダー/リストを取得できませんでした`);
}

/** 表示中の期間が取得済みの範囲から外れそうなら取り直す */
export function ensureWindow() {
  const w = state.sync.window;
  if (state.auth.status !== 'connected' || !w) return;
  const c = state.ui.cursor;
  if (addDays(c, -45) < w.min || addDays(c, 45) > w.max) syncNow();
}

// ---- 起動時の準備 ----

let pushTimer = 0;
let notesTimer = 0;

export async function initSync() {
  onMutation(() => {
    if (state.auth.status !== 'connected') return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, 900);
  });
  onNoteChange(() => {
    if (state.auth.status !== 'connected') return;
    clearTimeout(notesTimer);
    notesTimer = setTimeout(notesNow, 4000); // 書き終わって少し経ってから送る
  });

  const stale = () => !state.sync.lastSync || Date.now() - state.sync.lastSync > 2 * 60_000;
  const whenBack = () => {
    if (document.visibilityState === 'visible' && stale()) syncNow();
  };
  window.addEventListener('focus', whenBack);
  document.addEventListener('visibilitychange', whenBack); // スマホでアプリに戻ってきたとき
  setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, AUTO_SYNC_MS);

  // Google のログイン画面から戻ってきた直後なら、結果を受け取って URL を元に戻す
  const login = g.finishLogin(); // ブラウザだけの方式（URL の # 以降にトークン）
  const params = new URLSearchParams(location.search); // サーバー方式（?auth=ok / ?auth_error=…）
  const authError = params.get('auth_error');
  const loggedIn = login?.ok || params.has('auth');
  if (authError || params.has('auth')) history.replaceState(null, '', location.pathname);

  // 「今日の一覧」など別のページから接続を始めていたら、そのページへ戻る
  const back = safeReturnPath(localStorage.getItem(RETURN_KEY), location.pathname);
  localStorage.removeItem(RETURN_KEY);
  if (loggedIn && back) {
    location.replace(back);
    return;
  }

  state.backend = await backend.fetchStatus();
  // サーバー方式では、サーバーに保存したクライアント ID が正
  if (state.backend?.hasSecret && state.backend.clientId) state.settings.clientId = state.backend.clientId;

  if (usingBackend()) {
    // サーバー方式: トークンが切れても操作なしで取り直せるので、期限の見張りは要らない。
    // 以前の方式でブラウザに保存したトークンが残っていれば消す（以後はメモリ上にしか持たない）
    g.clearToken();
    g.useTokenSource(serverToken);
    state.auth = { status: 'connected', error: null };
    emit('settings');
    syncNow();
  } else if (g.hasValidToken() && state.settings.clientId) {
    state.auth = { status: 'connected', error: null };
    watchExpiry();
    syncNow();
  } else if (state.settings.accountHint) {
    // 以前は接続していた → ボタン 1 つで再接続できる状態にする
    state.auth = { status: 'expired', error: null };
    emit();
  } else {
    emit();
  }
  if (authError) setAuth(state.auth.status, backend.AUTH_ERRORS[authError] || `Google との接続に失敗しました（${authError}）`);
  else if (login?.error) setAuth(state.auth.status, login.error);
}
