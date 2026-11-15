// 状態を持たない純粋なロジック（並び順・日付ごとの索引・同期のマージ・週表示のレイアウト）。
import { addDays, diffDays, timeToMin } from './dates.js';

/**
 * @typedef {Object} Item
 * @property {string} id
 * @property {'event'|'task'} kind         予定 / タスク
 * @property {string} title
 * @property {string} description
 * @property {string|null} date            開始日。日付なしタスクのみ null
 * @property {string|null} endDate         予定の最終日（終日はその日を含む / 時刻ありは終了時刻のある日）
 * @property {string|null} startTime       null なら終日
 * @property {string|null} endTime
 * @property {boolean} done                タスクの完了
 * @property {'synced'|'create'|'update'|'delete'} sync  Google への反映状態
 * @property {{id:string, containerId:string, recurring?:boolean, htmlLink?:string}} [google]
 * @property {string} [target]             新規作成時の送信先（カレンダーID / タスクリストID）
 * @property {boolean} [readOnly]
 * @property {string|null} [color]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

export const googleKey = i => (i.google ? `${i.kind}:${i.google.containerId}:${i.google.id}` : null);

/**
 * Google から取得した一覧をローカルに取り込む。
 * 未送信の変更（sync !== 'synced'）はローカルを優先して残し、それ以外は Google 側の内容で置き換える。
 * keepContainers に含まれるカレンダー/リストは取得に失敗したものなので、手元の内容を残す。
 */
export function mergeRemote(local, remote, keepContainers = new Set()) {
  const out = [];
  const kept = new Set();
  const known = new Map();
  for (const i of local) {
    const k = googleKey(i);
    if (k) known.set(k, i);
    if (i.sync !== 'synced' || (i.google && keepContainers.has(i.google.containerId))) {
      out.push(i);
      if (k) kept.add(k);
    }
  }
  for (const r of remote) {
    const k = googleKey(r);
    if (kept.has(k)) continue;
    const prev = known.get(k);
    out.push(prev ? { ...r, id: prev.id, createdAt: prev.createdAt ?? r.createdAt } : r);
  }
  return out;
}

/** 予定が占める最後の日（0:00 ちょうどに終わる予定は前日まで） */
export function spanEnd(i) {
  if (i.kind !== 'event' || !i.endDate || i.endDate <= i.date) return i.date;
  if (i.startTime && i.endTime === '00:00') return addDays(i.endDate, -1);
  return i.endDate;
}

/** 終日の予定 → 時刻のある予定 → タスク（未完了が先）の順 */
export function compareItems(a, b) {
  const rank = i => (i.kind === 'task' ? 2 : i.startTime ? 1 : 0);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1 && a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
  if (ra === 2 && a.done !== b.done) return a.done ? 1 : -1;
  if (ra === 2 && a.createdAt !== b.createdAt) return (a.createdAt || 0) - (b.createdAt || 0);
  return a.title.localeCompare(b.title, 'ja');
}

/** 日付 → その日に表示するアイテムの Map。複数日の予定は各日に入る */
export function buildDayIndex(items) {
  const map = new Map();
  for (const i of items) {
    if (!i.date) continue;
    const last = spanEnd(i);
    let d = i.date;
    for (let n = 0; d <= last && n < 400; n++) {
      let list = map.get(d);
      if (!list) map.set(d, (list = []));
      list.push(i);
      d = addDays(d, 1);
    }
  }
  for (const list of map.values()) list.sort(compareItems);
  return map;
}

/** その日の時間軸に置く区間（分）を返す。日をまたぐ予定はその日の分だけ切り出す */
export function daySegments(items, date) {
  const segs = [];
  for (const item of items) {
    if (item.kind !== 'event' || !item.startTime) continue;
    const end = item.endDate || item.date;
    const s = date === item.date ? timeToMin(item.startTime) : 0;
    const e = date === end ? timeToMin(item.endTime || item.startTime) : 1440;
    if (e > s) segs.push({ item, s, e });
    else if (e === s && date === item.date) segs.push({ item, s, e: Math.min(s + 30, 1440) });
  }
  return segs;
}

/** 重なる予定を横に並べる。各区間に col（何列目か）と cols（全何列か）を付ける */
export function layoutSegments(segs, minLen = 30) {
  const sorted = [...segs].sort((a, b) => a.s - b.s || b.e - a.e);
  const vis = seg => Math.max(seg.e, seg.s + minLen);
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const colEnds = [];
    for (const seg of cluster) {
      let c = colEnds.findIndex(end => end <= seg.s);
      if (c === -1) c = colEnds.length;
      colEnds[c] = vis(seg);
      seg.col = c;
    }
    for (const seg of cluster) seg.cols = colEnds.length;
    cluster = [];
    clusterEnd = -1;
  };
  for (const seg of sorted) {
    if (cluster.length && seg.s >= clusterEnd) flush();
    cluster.push(seg);
    clusterEnd = Math.max(clusterEnd, vis(seg));
  }
  if (cluster.length) flush();
  return sorted;
}

/** ドラッグで別の日へ移すときの変更内容。予定は長さを保ったままずらす */
export function shiftDates(item, fromDate, toDate) {
  if (!item.date) return { date: toDate };
  const delta = diffDays(fromDate || item.date, toDate);
  return {
    date: addDays(item.date, delta),
    endDate: item.endDate ? addDays(item.endDate, delta) : null,
  };
}

const NOTE_KEY = /^[dw]:\d{4}-\d{2}-\d{2}$/;
const DELETED_NOTE_TTL = 180 * 86400_000;

/**
 * 手元のメモと、Google ドライブ上のメモ（他の端末が書いたもの）を突き合わせる。
 * メモごとに更新時刻の新しいほうを残す。消したメモは「本文が空」の記録として伝える。
 *   local:     { notes: { キー: 本文 }, times: { キー: 更新時刻 } }
 *   remoteDoc: { version: 1, notes: { キー: { t: 本文, u: 更新時刻 } } } / まだ無ければ null
 * 戻り値: incoming = 手元に取り込む [キー, 本文, 更新時刻]、doc = 突き合わせ後の全体、
 *         upload = ドライブ側を書き換える必要があるか
 */
export function mergeNotes(local, remoteDoc, now = Date.now()) {
  const remote = remoteDoc?.notes && typeof remoteDoc.notes === 'object' ? remoteDoc.notes : {};
  const keys = new Set([...Object.keys(local.notes), ...Object.keys(local.times), ...Object.keys(remote)]);
  const incoming = [];
  const merged = {};
  let upload = !remoteDoc;
  for (const key of keys) {
    if (!NOTE_KEY.test(key)) continue;
    const lText = local.notes[key] || '';
    const lTime = local.times[key] || (lText ? 1 : 0);
    const r = remote[key];
    const rValid = !!r && typeof r.t === 'string' && Number.isFinite(r.u) && r.u > 0;
    const rText = rValid ? r.t : '';
    const rTime = rValid ? r.u : 0;
    const remoteWins = rTime > lTime;
    const text = remoteWins ? rText : lText;
    const time = remoteWins ? rTime : lTime;
    if (!time) continue;
    if (remoteWins) incoming.push([key, rText, rTime]);
    else if (lTime > rTime) upload = true;
    if (!text.trim() && now - time > DELETED_NOTE_TTL) {
      if (rValid) upload = true; // 古い削除記録は片付ける
      continue;
    }
    merged[key] = { t: text, u: time };
  }
  return { incoming, doc: { version: 1, notes: merged }, upload };
}
