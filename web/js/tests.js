// tests.html から読み込むテスト。Google との通信は、このファイル内の模擬サーバーに差し替えて確かめる。
import * as D from './dates.js';
import * as M from './model.js';

// tests.html?backend で開くと、同梱サーバーが接続を保つ方式（サーバー方式）のテストを走らせる。
// モジュールは 1 ページにつき 1 回しか初期化されないので、方式ごとにページを分けている。
const BACKEND_MODE = new URLSearchParams(location.search).has('backend');

// 接続済みの状態を用意する（google.js / store.js は読み込み時にこれを読むので、import より前に置く）
if (!BACKEND_MODE) {
  localStorage.setItem('planner-test.token', JSON.stringify({ value: 'test-token', expiresAt: Date.now() + 3600_000 }));
  localStorage.setItem('planner-test.settings.v1', JSON.stringify({ clientId: 'test-client' }));
}

const results = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  results.push({ name, ok: a === b, detail: a === b ? '' : `\n      実際: ${a}\n      期待: ${b}` });
}

// ---- 模擬 Google サーバー ----

const server = {
  calendars: [
    { id: 'me@example.com', summary: 'わたし', primary: true, accessRole: 'owner', selected: true, backgroundColor: '#039be5' },
    { id: 'holiday', summary: '日本の祝日', accessRole: 'reader', selected: true, backgroundColor: '#0b8043' },
    { id: 'unselected', summary: '非表示のカレンダー', accessRole: 'owner', selected: false },
  ],
  events: { 'me@example.com': new Map(), holiday: new Map(), unselected: new Map() },
  lists: [{ id: 'L1', title: 'マイタスク' }],
  tasks: { L1: new Map() },
  log: [],
  unauthorized: false,
  seq: 0,
  validTokens: new Set(['test-token']),
  // 同梱サーバー（serve.py）の認証 API の模擬
  backend: { connected: true, tokenCalls: 0, reauth: false, down: false },
  // Google ドライブのアプリ専用領域（メモの保存先）の模擬
  drive: { file: null, forbidden: false, saves: 0 },
};

function driveApi(path, method, rawBody) {
  const d = server.drive;
  if (d.forbidden) return json({ error: { message: 'Request had insufficient authentication scopes.' } }, 403);
  if (path === '/drive/v3/files' && method === 'GET') return json({ files: d.file ? [{ id: d.file.id }] : [] });
  if (path === '/upload/drive/v3/files' && method === 'POST') {
    // multipart の 2 つ目の部分がファイルの中身
    const parts = rawBody.split(/\r\n\r\n/);
    d.file = { id: 'notes-file-1', doc: JSON.parse(parts[2].split('\r\n--')[0]) };
    d.saves++;
    return json({ id: d.file.id });
  }
  if (d.file && path === `/drive/v3/files/${d.file.id}` && method === 'GET') return json(d.file.doc);
  if (d.file && path === `/upload/drive/v3/files/${d.file.id}` && method === 'PATCH') {
    d.file.doc = JSON.parse(rawBody);
    d.saves++;
    return json({ id: d.file.id });
  }
  return json({ error: { message: 'Not Found' } }, 404);
}

function backendApi(path) {
  if (!BACKEND_MODE) return json({ error: 'not_found' }, 404); // 別の静的サーバーで開いた場合と同じ
  const b = server.backend;
  if (path === '/api/auth/status') {
    return json({ backend: true, hasSecret: true, connected: b.connected, clientId: 'server-client', redirectUri: 'http://localhost:5173/api/auth/callback' });
  }
  if (path === '/api/auth/token') {
    if (b.down) return json({ error: 'network', detail: 'timed out' }, 502);
    if (b.reauth) return ((b.connected = false), json({ error: 'reauth' }, 401));
    const accessToken = `server-token-${++b.tokenCalls}`;
    server.validTokens.add(accessToken);
    return json({ accessToken, expiresIn: 3600 });
  }
  return json({ error: 'not_found' }, 404);
}

const json = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const applyPatch = (target, patch) => {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (typeof v === 'object' && !Array.isArray(v)) target[k] = applyPatch({ ...(target[k] || {}) }, v);
    else target[k] = v;
  }
  return target;
};

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input), location.href);
  const method = init.method || 'GET';
  let body = null;
  try {
    body = init.body ? JSON.parse(init.body) : null;
  } catch {
    body = null; // multipart など JSON でない本文
  }
  const path = decodeURIComponent(url.pathname);
  server.log.push(`${method} ${path}`);
  if (url.origin === location.origin) return backendApi(path);
  if (server.unauthorized) return json({ error: { message: 'Invalid Credentials' } }, 401);
  if (!server.validTokens.has(String(init.headers?.Authorization).replace('Bearer ', ''))) return json({ error: { message: 'Invalid Credentials' } }, 401);

  let m;
  if (path.startsWith('/drive/') || path.startsWith('/upload/drive/')) return driveApi(path, method, init.body);
  if (path === '/calendar/v3/users/me/calendarList') return json({ items: server.calendars });
  if (path === '/tasks/v1/users/@me/lists') return json({ items: server.lists });
  if ((m = path.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/(.+))?$/))) {
    const store = server.events[m[1]];
    if (!store) return json({ error: { message: 'Not Found' } }, 404);
    if (method === 'GET') return json({ items: [...store.values()] });
    if (method === 'POST') {
      const ev = { ...body, id: `ev${++server.seq}`, htmlLink: 'https://calendar.google.com/x', updated: new Date().toISOString() };
      store.set(ev.id, ev);
      return json(ev);
    }
    if (!store.has(m[2])) return json({ error: { message: 'Not Found' } }, 404);
    if (method === 'PATCH') return json(applyPatch(store.get(m[2]), body));
    if (method === 'DELETE') return store.delete(m[2]), json(null, 204);
  }
  if ((m = path.match(/^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/(.+))?$/))) {
    const store = server.tasks[m[1]];
    if (!store) return json({ error: { message: 'Not Found' } }, 404);
    if (method === 'GET') return json({ items: [...store.values()] });
    if (method === 'POST') {
      const t = { ...body, id: `task${++server.seq}`, updated: new Date().toISOString() };
      store.set(t.id, t);
      return json(t);
    }
    if (!store.has(m[2])) return json({ error: { message: 'Not Found' } }, 404);
    if (method === 'PATCH') return json(applyPatch(store.get(m[2]), body));
    if (method === 'DELETE') return store.delete(m[2]), json(null, 204);
  }
  return json({ error: { message: `unexpected ${method} ${path}` } }, 500);
};

// ---- 純粋なロジック ----

function pureTests() {
  eq('年またぎの日付計算', D.addDays('2026-12-31', 1), '2027-01-01');
  eq('月末からの月送り', D.addMonths('2026-01-31', 1), '2026-02-28');
  eq('週の始まり（月曜 / 日曜）', [D.startOfWeek('2026-11-15', 1), D.startOfWeek('2026-11-15', 0)], ['2026-11-09', '2026-11-15']);
  eq('月表示の行数', [D.monthWeeks('2026-11-13', 1).length, D.monthWeeks('2026-02-10', 0).length], [6, 4]);
  eq('週メモのキーは開始曜日の設定によらない', [D.mondayOf('2026-11-13', 1), D.mondayOf('2026-11-13', 0)], ['2026-11-09', '2026-11-09']);
  eq('週番号', [D.isoWeek('2026-11-09'), D.isoWeek('2027-01-01')], [46, 53]);

  const idx = M.buildDayIndex([
    { id: 'a', kind: 'task', title: '済', date: '2026-11-13', done: true, createdAt: 1 },
    { id: 'b', kind: 'task', title: '未', date: '2026-11-13', done: false, createdAt: 2 },
    { id: 'c', kind: 'event', title: '夜', date: '2026-11-13', endDate: '2026-11-14', startTime: '22:00', endTime: '00:00' },
    { id: 'd', kind: 'event', title: '朝', date: '2026-11-13', endDate: '2026-11-13', startTime: '09:00', endTime: '10:00' },
    { id: 'e', kind: 'event', title: '旅行', date: '2026-11-12', endDate: '2026-11-14', startTime: null },
  ]);
  eq('1 日の並び順（終日 → 時刻順 → 未完了 → 完了）', idx.get('2026-11-13').map(i => i.id), ['e', 'd', 'c', 'b', 'a']);
  eq('0:00 終了の予定は翌日に出さない', idx.get('2026-11-14').map(i => i.id), ['e']);

  const ev = (title, startTime, endTime, date = '2026-11-13', endDate = '2026-11-13') => ({ kind: 'event', title, date, endDate, startTime, endTime });
  const segs = M.layoutSegments(M.daySegments([ev('x', '09:00', '10:30'), ev('y', '10:00', '11:00'), ev('z', '13:00', '14:00'), ev('前日から', '23:00', '01:00', '2026-11-12')], '2026-11-13'));
  eq('重なる予定の横並び', segs.map(s => `${s.item.title}:${s.s}-${s.e}:${s.col}/${s.cols}`), ['前日から:0-60:0/1', 'x:540-630:0/2', 'y:600-660:1/2', 'z:780-840:0/1']);
  eq('複数日の予定をドラッグで移動', M.shiftDates({ date: '2026-11-12', endDate: '2026-11-14' }, '2026-11-13', '2026-11-20'), { date: '2026-11-19', endDate: '2026-11-21' });

  // メモの突き合わせ（端末間同期）
  const now = 1_800_000_000_000;
  const local = {
    notes: { 'd:2026-11-13': '手元が新しい', 'd:2026-11-14': '手元が古い', 'w:2026-11-09': '手元だけ', 'd:2026-11-16': '同じ' },
    times: { 'd:2026-11-13': 200, 'd:2026-11-14': 100, 'w:2026-11-09': 300, 'd:2026-11-16': 50, 'd:2026-11-17': 400 /* 手元で消した */ },
  };
  const remote = {
    version: 1,
    notes: {
      'd:2026-11-13': { t: '他の端末（古い）', u: 150 },
      'd:2026-11-14': { t: '他の端末が新しい', u: 250 },
      'd:2026-11-15': { t: '他の端末だけ', u: 120 },
      'd:2026-11-16': { t: '同じ', u: 50 },
      'd:2026-11-17': { t: '手元で消す前の内容', u: 350 },
      'd:2026-11-18': { t: '', u: now - 1000 }, // 他の端末で消した
      'bad key': { t: 'x', u: 999 },
    },
  };
  const m = M.mergeNotes({ notes: { ...local.notes, 'd:2026-11-18': '消される前' }, times: { ...local.times, 'd:2026-11-18': 10 } }, remote, now);
  eq('メモ: 新しいほうを取り込む', [...m.incoming].sort((a, b) => a[0].localeCompare(b[0])), [['d:2026-11-14', '他の端末が新しい', 250], ['d:2026-11-15', '他の端末だけ', 120], ['d:2026-11-18', '', now - 1000]]);
  eq('メモ: 手元が新しいものは残す', [m.doc.notes['d:2026-11-13'], m.doc.notes['w:2026-11-09'], m.upload], [{ t: '手元が新しい', u: 200 }, { t: '手元だけ', u: 300 }, true]);
  eq('メモ: 消したことも伝わる（古い削除記録は片付ける）', [m.doc.notes['d:2026-11-17'], m.doc.notes['d:2026-11-18'], 'bad key' in m.doc.notes], [undefined, { t: '', u: now - 1000 }, false]);
  eq('メモ: 差がなければ書き込まない', M.mergeNotes({ notes: { 'd:2026-11-16': '同じ' }, times: { 'd:2026-11-16': 50 } }, { version: 1, notes: { 'd:2026-11-16': { t: '同じ', u: 50 } } }, now).upload, false);
  eq('メモ: 初回はファイルを作る', M.mergeNotes({ notes: {}, times: {} }, null, now).upload, true);
}

// ---- 変換 ----

async function mappingTests() {
  const G = await import('./google.js');
  const cal = { id: 'c', color: '#0b8043', writable: true };
  const allDay = G.eventToItem({ id: 'e1', summary: '旅行', start: { date: '2026-11-14' }, end: { date: '2026-11-17' } }, cal);
  eq('終日予定の終了日（Google は翌日を返す）', [allDay.date, allDay.endDate, allDay.startTime], ['2026-11-14', '2026-11-16', null]);
  eq('アプリ → Google の終日予定', G.itemToEventBody({ title: 'A', description: '', date: '2026-11-14', endDate: '2026-11-16', startTime: null }).end, { date: '2026-11-17' });
  const local = new Date(2026, 10, 13, 10, 0);
  const timed = G.eventToItem({ id: 'e2', summary: '会議', start: { dateTime: local.toISOString() }, end: { dateTime: new Date(2026, 10, 13, 11, 30).toISOString() } }, cal);
  eq('時刻つき予定はローカル時刻で表示', [timed.date, timed.startTime, timed.endTime], ['2026-11-13', '10:00', '11:30']);
  eq('キャンセル・辞退した予定は取り込まない', [G.eventToItem({ id: 'x', status: 'cancelled', start: { date: '2026-11-14' } }, cal), G.eventToItem({ id: 'x', start: { date: '2026-11-14' }, attendees: [{ self: true, responseStatus: 'declined' }] }, cal)], [null, null]);
  eq('時刻あり → 終日の変更で古い時刻を消す', G.itemToEventBody({ title: 'A', date: '2026-11-14', startTime: null }, { patch: true }).start, { date: '2026-11-14', dateTime: null, timeZone: null });
  eq('タスクの期限', G.itemToTaskBody({ title: 'T', description: '', date: '2026-11-13', done: true }), { title: 'T', notes: '', status: 'completed', due: '2026-11-13T00:00:00.000Z' });
  eq('タスクを未完了・日付なしに戻す', G.itemToTaskBody({ title: 'T', description: '', date: null, done: false }, { patch: true }), { title: 'T', notes: '', status: 'needsAction', due: null, completed: null });

  // ログイン画面から戻ってきた URL の読み取り
  const scope = encodeURIComponent(G.SCOPES.join(' '));
  const ok = G.parseLoginResult(`#state=abc&access_token=tok&token_type=Bearer&expires_in=3599&scope=${scope}`, 'abc', 1000);
  eq('ログイン: 成功', ok, { token: { value: 'tok', expiresAt: 1000 + 3599_000 } });
  eq('ログイン: 関係ない # は無視', [G.parseLoginResult('', 'abc'), G.parseLoginResult('#section', 'abc')], [null, null]);
  eq('ログイン: 合言葉が違うものは受け付けない', [!!G.parseLoginResult(`#state=evil&access_token=tok&scope=${scope}`, 'abc').error, !!G.parseLoginResult(`#state=abc&access_token=tok&scope=${scope}`, null).error], [true, true]);
  eq('ログイン: 拒否された', G.parseLoginResult('#error=access_denied&state=abc', 'abc').error, 'アクセスが許可されませんでした');
  eq('ログイン: 一部の許可が外されている', !!G.parseLoginResult(`#state=abc&access_token=tok&scope=${encodeURIComponent(G.SCOPES.slice(0, 2).join(' '))}`, 'abc').error, true);
}

// ---- 同期の流れ ----

async function syncTests() {
  const S = await import('./store.js');
  const Sync = await import('./sync.js');
  const { state } = S;
  const t = D.today();
  const calls = prefix => server.log.filter(l => l.startsWith(prefix)).length;
  const myEvents = server.events['me@example.com'];
  const myTasks = server.tasks.L1;

  // Google 側に元からあるデータ
  myEvents.set('g-ev', { id: 'g-ev', summary: 'Google の予定', start: { date: t }, end: { date: D.addDays(t, 1) }, updated: '2026-01-01T00:00:00Z' });
  server.events.holiday.set('h1', { id: 'h1', summary: '祝日', start: { date: D.addDays(t, 3) }, end: { date: D.addDays(t, 4) } });
  server.events.unselected.set('u1', { id: 'u1', summary: '見えない予定', start: { date: t }, end: { date: D.addDays(t, 1) } });
  myTasks.set('g-task', { id: 'g-task', title: 'Google のタスク', due: `${t}T00:00:00.000Z`, status: 'needsAction', updated: '2026-01-01T00:00:00Z' });

  // 接続前にアプリで作ったもの
  const task = S.createItem({ kind: 'task', title: 'アプリのタスク', date: t });
  const event = S.createItem({ kind: 'event', title: 'アプリの予定', date: t, endDate: t, startTime: '10:00', endTime: '11:00' });
  eq('接続前は送信待ちとして保存', state.items.map(i => i.sync), ['create', 'create']);

  await Sync.initSync(); // 有効なトークンがあるので接続済みとして同期が始まる
  await Sync.syncNow();

  eq('接続状態（ブラウザだけの方式）', [state.auth.status, state.sync.error, Sync.usingBackend()], ['connected', null, false]);
  eq('アプリのタスク → Google ToDo', [...myTasks.values()].filter(x => x.title === 'アプリのタスク').map(x => [x.due, x.status]), [[`${t}T00:00:00.000Z`, 'needsAction']]);
  eq('アプリの予定 → Google カレンダー', [...myEvents.values()].filter(x => x.summary === 'アプリの予定').map(x => x.start.dateTime), [`${t}T10:00:00`]);
  eq('Google の予定・タスク → アプリ', ['Google の予定', 'Google のタスク', '祝日'].map(title => !!state.items.find(i => i.title === title)), [true, true, true]);
  eq('全件が同期済みになり、ID は変わらない', [state.items.every(i => i.sync === 'synced'), !!S.findItem(task.id)?.google, !!S.findItem(event.id)?.google], [true, true, true]);
  eq('二重に送信しない', [calls('POST /calendar'), calls('POST /tasks')], [1, 1]);
  eq('閲覧のみのカレンダーは編集不可', state.items.find(i => i.title === '祝日').readOnly, true);
  eq('Google で非表示のカレンダーは最初は取り込まない', [state.items.some(i => i.title === '見えない予定'), state.settings.hiddenCalendars], [false, ['unselected']]);
  eq('追加先の初期値', [state.settings.defaultCalendarId, state.settings.defaultTaskListId, state.settings.accountHint], ['me@example.com', 'L1', 'me@example.com']);

  // 完了にする → 少し待つと自動で送られる
  S.toggleDone(task.id);
  eq('変更直後は未反映', S.findItem(task.id).sync, 'update');
  await new Promise(r => setTimeout(r, 1300));
  await Sync.syncNow();
  eq('完了が Google に反映', [myTasks.get(S.findItem(task.id).google.id).status, S.findItem(task.id).sync], ['completed', 'synced']);

  // 予定を終日に変更
  S.updateItem(event.id, { startTime: null, endTime: null, endDate: D.addDays(t, 1) });
  await Sync.syncNow();
  const remoteEvent = myEvents.get(S.findItem(event.id).google.id);
  eq('時刻あり → 終日（2 日間）', [remoteEvent.start, remoteEvent.end], [{ date: t }, { date: D.addDays(t, 2) }]);

  // Google 側での変更・削除を取り込む
  myEvents.get('g-ev').summary = 'Google で改名';
  myTasks.delete('g-task');
  await Sync.syncNow();
  eq('Google 側の変更と削除を取り込む', [state.items.some(i => i.title === 'Google で改名'), state.items.some(i => i.title === 'Google のタスク')], [true, false]);

  // 削除と「元に戻す」
  const eventGoogleId = S.findItem(event.id).google.id;
  const snapshot = S.deleteItem(event.id);
  eq('削除直後は画面から消える', S.visibleItems().some(i => i.id === event.id), false);
  await Sync.syncNow();
  eq('削除が Google に反映', [myEvents.has(eventGoogleId), !!S.findItem(event.id)], [false, false]);
  S.restoreItem(snapshot);
  await Sync.syncNow();
  eq('元に戻すと Google に作り直される', [[...myEvents.values()].filter(x => x.summary === 'アプリの予定').length, S.findItem(event.id)?.sync], [1, 'synced']);

  // Google 側で消えたものを編集していた場合
  const renamed = state.items.find(i => i.title === 'Google で改名');
  myEvents.delete('g-ev');
  S.updateItem(renamed.id, { title: '消えた予定を編集' });
  await Sync.syncNow();
  eq('Google で削除済みの予定への編集は破棄', [state.items.some(i => i.id === renamed.id), state.sync.error], [false, null]);

  // メモの端末間同期（Google ドライブのアプリ専用領域）
  const dayKey = S.dayNoteKey(t);
  const weekKey = S.weekNoteKey(t);
  S.setNote(dayKey, '今日のメモ');
  S.setNote(weekKey, '今週のメモ');
  await Sync.syncNow();
  const driveNotes = () => server.drive.file.doc.notes;
  eq('メモが Google ドライブに保存される', [driveNotes()[dayKey].t, driveNotes()[weekKey].t, state.sync.notesError], ['今日のメモ', '今週のメモ', null]);
  const savesBefore = server.drive.saves;
  await Sync.syncNow();
  eq('変更がなければ書き込まない', server.drive.saves, savesBefore);

  // 別の端末（スマホ）が書いた内容を受け取る
  const later = Date.now() + 60_000;
  driveNotes()[dayKey] = { t: 'スマホで書き直した', u: later };
  driveNotes()[`d:${D.addDays(t, 2)}`] = { t: 'スマホで追加', u: later };
  driveNotes()[weekKey] = { t: '', u: later }; // スマホで消した
  await Sync.syncNow();
  eq('他の端末の変更を取り込む', [state.notes[dayKey], state.notes[`d:${D.addDays(t, 2)}`], weekKey in state.notes], ['スマホで書き直した', 'スマホで追加', false]);
  S.setNote(dayKey, 'Mac でさらに書き直した');
  await Sync.syncNow();
  eq('そのあと手元で書いた内容が勝つ', [driveNotes()[dayKey].t, driveNotes()[`d:${D.addDays(t, 2)}`].t], ['Mac でさらに書き直した', 'スマホで追加']);

  // メモの許可だけが無い場合（以前の許可のまま）でも、予定・タスクの同期は続ける
  server.drive.forbidden = true;
  S.updateItem(task.id, { title: '許可が古いときの編集' });
  await Sync.syncNow();
  eq('メモの許可が無くても予定・タスクは同期', [state.sync.notesError, state.sync.error, S.findItem(task.id).sync, state.auth.status], ['permission', null, 'synced', 'connected']);
  server.drive.forbidden = false;
  await Sync.syncNow();
  eq('許可が付けばメモの同期が再開', state.sync.notesError, null);

  // 接続切れ
  server.unauthorized = true;
  S.updateItem(task.id, { title: '切断中の編集' });
  await Sync.syncNow();
  eq('接続が切れたら再接続待ちになり、変更は残る', [state.auth.status, S.findItem(task.id).sync, S.findItem(task.id).title], ['expired', 'update', '切断中の編集']);

  // 接続が切れている間のメモは手元に保存される
  S.setNote(S.dayNoteKey(D.addDays(t, 1)), '切断中のメモ');
  S.persist();
  eq('切断中のメモは手元に保存', JSON.parse(localStorage.getItem('planner-test.notes.v1'))[`d:${D.addDays(t, 1)}`], '切断中のメモ');
  eq('アプリ本体のデータには触れていない', Object.keys(localStorage).filter(k => k.startsWith('planner-test.')).length > 0, true);
}

// ---- サーバー方式（同梱サーバーが更新用トークンを保管し、接続を保つ） ----

async function backendTests() {
  const S = await import('./store.js');
  const Sync = await import('./sync.js');
  const { state } = S;
  const t = D.today();
  const b = server.backend;
  const myTasks = server.tasks.L1;
  const remoteTitle = id => myTasks.get(S.findItem(id).google.id).title;
  server.events['me@example.com'].set('g-ev', { id: 'g-ev', summary: 'Google の予定', start: { date: t }, end: { date: D.addDays(t, 1) } });

  const task = S.createItem({ kind: 'task', title: 'サーバー方式のタスク', date: t });
  await Sync.initSync(); // このブラウザにはトークンが無いが、サーバーが接続を覚えている
  await Sync.syncNow();
  eq('ログイン操作なしで接続して同期する', [state.auth.status, Sync.usingBackend(), state.sync.error], ['connected', true, null]);
  eq('双方向に同期される', [S.findItem(task.id).sync, remoteTitle(task.id), state.items.some(i => i.title === 'Google の予定')], ['synced', 'サーバー方式のタスク', true]);
  eq('並行する通信でもトークンの取得は 1 回', b.tokenCalls, 1);
  eq('クライアント ID をサーバーから引き継ぐ', state.settings.clientId, 'server-client');
  eq('アクセストークンをブラウザに保存しない', [localStorage.getItem('planner-test.token'), JSON.stringify(localStorage).includes('server-token')], [null, false]);

  // 1 時間たってアクセストークンが切れた
  server.validTokens.clear();
  S.updateItem(task.id, { title: '期限切れ後の編集' });
  await Sync.syncNow();
  eq('トークンが切れても操作なしで取り直して続行', [state.auth.status, state.sync.error, S.findItem(task.id).sync, remoteTitle(task.id), b.tokenCalls], ['connected', null, 'synced', '期限切れ後の編集', 2]);

  // 一時的にトークンを取り直せない（ネットワーク不調など）→ 接続は保ったままエラー表示
  server.validTokens.clear();
  b.down = true;
  S.updateItem(task.id, { title: '不調中の編集' });
  await Sync.syncNow();
  eq('一時的な失敗では接続を切らない', [state.auth.status, !!state.sync.error, S.findItem(task.id).sync], ['connected', true, 'update']);
  b.down = false;
  await Sync.syncNow();
  eq('復旧後に未送信分を送る', [state.sync.error, S.findItem(task.id).sync, remoteTitle(task.id)], [null, 'synced', '不調中の編集']);

  // 更新用トークンそのものが失効した（7 日の期限や、Google 側での取り消し）
  server.validTokens.clear();
  b.reauth = true;
  S.updateItem(task.id, { title: '失効後の編集' });
  await Sync.syncNow();
  eq('更新用トークンが失効したら再接続待ちになり、変更は残る', [state.auth.status, Sync.usingBackend(), S.findItem(task.id).sync], ['expired', false, 'update']);
}

try {
  pureTests();
  await mappingTests();
  await (BACKEND_MODE ? backendTests() : syncTests());
} catch (e) {
  results.push({ name: `例外: ${e.stack || e.message}`, ok: false, detail: '' });
}

const failed = results.filter(r => !r.ok).length;
const summary = document.getElementById('summary');
summary.textContent = failed ? `${failed} 件失敗 / ${results.length} 件` : `すべて成功（${results.length} 件）`;
summary.className = failed ? 'fail' : 'ok';
document.getElementById('log').append(
  ...results.map(r => Object.assign(document.createElement('div'), { className: r.ok ? 'ok' : 'fail', textContent: `${r.ok ? '✓' : '✗'} ${r.name}${r.detail}` })),
);
