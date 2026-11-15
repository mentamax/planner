// Google カレンダー / Google ToDo リスト（Tasks）/ Google ドライブ（メモの保存先）との通信と、データ形式の変換。
import { addDays, toYMD, toHM } from './dates.js';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/tasks',
  // メモを端末間で同期するための、このアプリ専用の隠し領域。ドライブの他のファイルは見えない
  'https://www.googleapis.com/auth/drive.appdata',
];

const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const NS = globalThis.PLANNER_NS || 'planner';
const TOKEN_KEY = `${NS}.token`;
const LOGIN_KEY = `${NS}.login`;

export class AuthError extends Error {
  constructor(message = 'Google との接続が切れました') {
    super(message);
    this.name = 'AuthError';
  }
}

// ---- 認証（ブラウザだけの方式） ----
// ページごと Google のログイン画面へ移動し、戻ってきた URL の「#」以降でアクセストークンを受け取る。
// ポップアップを使わないので、スマホのホーム画面に追加したアプリでも動く。
// トークンの有効期間は約 1 時間で、切れたらもう一度ログイン画面を通る（許可済みならすぐ戻ってくる）。

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const LOGIN_STATE_TTL = 10 * 60_000;

let token = null;
try {
  token = JSON.parse(localStorage.getItem(TOKEN_KEY));
} catch {
  token = null;
}

export const tokenExpiresAt = () => token?.expiresAt || 0;
export const hasValidToken = () => !!token && token.expiresAt - Date.now() > 30_000;
export function clearToken() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
}

/** Google Cloud の「承認済みのリダイレクト URI」に登録するアドレス（＝このアプリを開いているアドレス） */
export const redirectUri = () => location.origin + location.pathname.replace(/index\.html$/, '');

/** Google のログイン画面へ移動する */
export function beginLogin(clientId) {
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem(LOGIN_KEY, JSON.stringify({ state, at: Date.now() }));
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPES.join(' '),
    state,
  });
  location.assign(`${AUTH_ENDPOINT}?${query}`);
}

/**
 * 戻ってきた URL の「#」以降を読み取る。ログインの戻りでなければ null。
 * expectedState は出発時に控えた合言葉で、一致しないもの（他人が作ったリンクなど）は受け付けない。
 */
export function parseLoginResult(hash, expectedState, now = Date.now()) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  if (!p.has('access_token') && !p.has('error')) return null;
  if (!expectedState || p.get('state') !== expectedState) {
    return { error: 'ログインを確認できませんでした。もう一度接続してください' };
  }
  if (p.has('error')) {
    const code = p.get('error');
    return { error: code === 'access_denied' ? 'アクセスが許可されませんでした' : `Google との接続に失敗しました（${code}）` };
  }
  const granted = new Set((p.get('scope') || '').split(/\s+/));
  if (!SCOPES.every(s => granted.has(s))) {
    return { error: 'カレンダー・ToDo リスト・メモの保存先のすべてにチェックを入れて許可してください' };
  }
  return { token: { value: p.get('access_token'), expiresAt: now + Number(p.get('expires_in') || 3600) * 1000 } };
}

/** ログイン画面から戻ってきた直後なら結果を取り込む。{ ok: true } / { error } / 戻りでなければ null */
export function finishLogin() {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(LOGIN_KEY));
  } catch {
    saved = null;
  }
  const fresh = saved && Date.now() - saved.at < LOGIN_STATE_TTL;
  const result = parseLoginResult(location.hash, fresh ? saved.state : null);
  if (!result) return null;
  history.replaceState(null, '', location.pathname + location.search); // トークンを URL と履歴に残さない
  localStorage.removeItem(LOGIN_KEY);
  if (result.error) return result;
  token = result.token;
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return { ok: true };
}

// ---- サーバー方式（同梱サーバーが更新用トークンを保管する） ----

let tokenSource = null; // async () => ({ accessToken, expiresIn })。設定されていればサーバー方式
let refreshing = null;

/** トークンの取得元を設定する。null でブラウザだけの方式に戻す */
export function useTokenSource(fn) {
  tokenSource = fn;
  refreshing = null;
}

/** 有効なアクセストークンを返す。サーバー方式なら、切れていても操作なしで取り直す */
async function ensureToken(force = false) {
  if (!force && hasValidToken()) return token.value;
  if (!tokenSource) throw new AuthError();
  refreshing ??= tokenSource()
    .then(t => {
      token = { value: t.accessToken, expiresAt: Date.now() + Number(t.expiresIn) * 1000 };
    })
    .finally(() => (refreshing = null));
  await refreshing;
  return token.value;
}

// ---- API 呼び出し ----

/** body は JSON として送る。raw と contentType を渡すと、その内容をそのまま送る */
async function api(url, options = {}, retry = true) {
  const { method = 'GET', query, body, raw, contentType } = options;
  const bearer = await ensureToken();
  const u = new URL(url);
  for (const [k, v] of Object.entries(query || {})) if (v != null) u.searchParams.set(k, v);
  const payload = raw ?? (body ? JSON.stringify(body) : undefined);
  const res = await fetch(u, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, ...(payload ? { 'Content-Type': contentType || 'application/json' } : {}) },
    body: payload,
  });
  if (res.status === 401) {
    // 同時に走っていた別の呼び出しがすでに取り直していたら、そのトークンは消さない
    if (token?.value === bearer) clearToken();
    if (tokenSource && retry) {
      await ensureToken();
      return api(url, options, false);
    }
    throw new AuthError();
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google API エラー (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function listAll(url, query, maxPages = 20) {
  const items = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const data = await api(url, { query: { ...query, pageToken } });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return items;
}

const enc = encodeURIComponent;

export const fetchCalendars = async () =>
  (await listAll(`${CAL}/users/me/calendarList`, { maxResults: 250 }))
    .filter(c => !c.deleted)
    .map(c => ({
      id: c.id,
      name: c.summaryOverride || c.summary || c.id,
      color: c.backgroundColor || null,
      primary: !!c.primary,
      writable: c.accessRole === 'owner' || c.accessRole === 'writer',
      selected: !!c.selected,
    }));

export const fetchEvents = async (cal, timeMin, timeMax) =>
  (await listAll(`${CAL}/calendars/${enc(cal.id)}/events`, { timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 2500 }))
    .map(ev => eventToItem(ev, cal))
    .filter(Boolean);

export const insertEvent = (calendarId, item) =>
  api(`${CAL}/calendars/${enc(calendarId)}/events`, { method: 'POST', body: itemToEventBody(item) });
export const patchEvent = (calendarId, eventId, item) =>
  api(`${CAL}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'PATCH', body: itemToEventBody(item, { patch: true }) });
export const deleteEvent = (calendarId, eventId) =>
  api(`${CAL}/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'DELETE' });

export const fetchTaskLists = async () =>
  (await listAll(`${TASKS}/users/@me/lists`, { maxResults: 100 })).map(l => ({ id: l.id, name: l.title || 'ToDo リスト' }));

export const fetchTasks = async list =>
  (await listAll(`${TASKS}/lists/${enc(list.id)}/tasks`, { showCompleted: true, showHidden: true, maxResults: 100 }))
    .map(t => taskToItem(t, list))
    .filter(Boolean);

export const insertTask = (listId, item) =>
  api(`${TASKS}/lists/${enc(listId)}/tasks`, { method: 'POST', body: itemToTaskBody(item) });
export const patchTask = (listId, taskId, item) =>
  api(`${TASKS}/lists/${enc(listId)}/tasks/${enc(taskId)}`, { method: 'PATCH', body: itemToTaskBody(item, { patch: true }) });
export const deleteTask = (listId, taskId) =>
  api(`${TASKS}/lists/${enc(listId)}/tasks/${enc(taskId)}`, { method: 'DELETE' });

// ---- メモの保存先（Google ドライブのアプリ専用領域） ----

const NOTES_FILE = 'planner-notes.json';

/** { id, doc }。まだファイルが無ければ { id: null, doc: null } */
export async function loadNotesFile() {
  const list = await api(`${DRIVE}/files`, {
    query: { spaces: 'appDataFolder', q: `name = '${NOTES_FILE}'`, orderBy: 'modifiedTime desc', pageSize: 10, fields: 'files(id)' },
  });
  const id = list?.files?.[0]?.id || null;
  if (!id) return { id: null, doc: null };
  const doc = await api(`${DRIVE}/files/${enc(id)}`, { query: { alt: 'media' } });
  return { id, doc: doc && typeof doc === 'object' ? doc : null };
}

export async function saveNotesFile(id, doc) {
  if (id) {
    return api(`${DRIVE_UPLOAD}/files/${enc(id)}`, { method: 'PATCH', query: { uploadType: 'media', fields: 'id' }, body: doc });
  }
  const boundary = `planner-${Math.random().toString(36).slice(2)}`;
  const part = (type, content) => `--${boundary}\r\nContent-Type: ${type}\r\n\r\n${content}\r\n`;
  const raw =
    part('application/json; charset=UTF-8', JSON.stringify({ name: NOTES_FILE, parents: ['appDataFolder'] })) +
    part('application/json; charset=UTF-8', JSON.stringify(doc)) +
    `--${boundary}--`;
  return api(`${DRIVE_UPLOAD}/files`, {
    method: 'POST',
    query: { uploadType: 'multipart', fields: 'id' },
    raw,
    contentType: `multipart/related; boundary=${boundary}`,
  });
}

// ---- 変換（Google の形式 ⇔ アプリのアイテム） ----

export function eventToItem(ev, cal) {
  if (!ev || ev.status === 'cancelled' || !ev.start) return null;
  if (ev.eventType === 'workingLocation') return null;
  if (ev.attendees?.some(a => a.self && a.responseStatus === 'declined')) return null;

  let date;
  let endDate;
  let startTime = null;
  let endTime = null;
  if (ev.start.date) {
    date = ev.start.date;
    endDate = ev.end?.date ? addDays(ev.end.date, -1) : date; // Google の終日予定は終了日が「翌日」
  } else {
    const s = new Date(ev.start.dateTime);
    const e = ev.end?.dateTime ? new Date(ev.end.dateTime) : s;
    date = toYMD(s);
    startTime = toHM(s);
    endDate = toYMD(e);
    endTime = toHM(e);
  }
  if (endDate < date) endDate = date;

  const stamp = Date.parse(ev.updated) || 0;
  return {
    id: `g:event:${cal.id}:${ev.id}`,
    kind: 'event',
    title: ev.summary || '(タイトルなし)',
    description: ev.description || '',
    date,
    endDate,
    startTime,
    endTime,
    done: false,
    sync: 'synced',
    google: { id: ev.id, containerId: cal.id, recurring: !!ev.recurringEventId, htmlLink: ev.htmlLink || '' },
    readOnly: !cal.writable || ev.eventType === 'birthday' || ev.eventType === 'fromGmail',
    color: cal.color || null,
    createdAt: Date.parse(ev.created) || stamp,
    updatedAt: stamp,
  };
}

export function itemToEventBody(item, { patch = false, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
  const body = { summary: item.title, description: item.description || '' };
  const endDate = item.endDate && item.endDate >= item.date ? item.endDate : item.date;
  if (!item.startTime) {
    body.start = { date: item.date };
    body.end = { date: addDays(endDate, 1) };
    if (patch) {
      // 時刻あり → 終日 に変えたとき、古い時刻を消す
      Object.assign(body.start, { dateTime: null, timeZone: null });
      Object.assign(body.end, { dateTime: null, timeZone: null });
    }
  } else {
    body.start = { dateTime: `${item.date}T${item.startTime}:00`, timeZone };
    body.end = { dateTime: `${endDate}T${item.endTime || item.startTime}:00`, timeZone };
    if (patch) {
      body.start.date = null;
      body.end.date = null;
    }
  }
  return body;
}

export function taskToItem(t, list) {
  if (!t || t.deleted) return null;
  if (!t.title?.trim() && !t.notes) return null; // Google 側の空行は取り込まない
  const stamp = Date.parse(t.updated) || 0;
  return {
    id: `g:task:${list.id}:${t.id}`,
    kind: 'task',
    title: t.title?.trim() || '(タイトルなし)',
    description: t.notes || '',
    date: t.due ? t.due.slice(0, 10) : null, // Google ToDo の期限は日付のみ
    endDate: null,
    startTime: null,
    endTime: null,
    done: t.status === 'completed',
    sync: 'synced',
    google: { id: t.id, containerId: list.id, htmlLink: t.webViewLink || '' },
    readOnly: false,
    color: null,
    completedAt: t.completed ? Date.parse(t.completed) : null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

export function itemToTaskBody(item, { patch = false } = {}) {
  const body = {
    title: item.title,
    notes: item.description || '',
    status: item.done ? 'completed' : 'needsAction',
  };
  if (item.date) body.due = `${item.date}T00:00:00.000Z`;
  else if (patch) body.due = null;
  if (patch && !item.done) body.completed = null;
  return body;
}
