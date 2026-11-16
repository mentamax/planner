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

/** メモのキー: d:日付（日）/ w:月曜の日付（週）/ m:年-月（月） */
export const NOTE_KEY = /^(?:[dw]:\d{4}-\d{2}-\d{2}|m:\d{4}-\d{2})$/;
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

// ---- 手書きメモ ----
// 1 ページの手書き: { key, u: 更新時刻, h: ページの高さ, strokes: [{ c: 色番号, w: 太さ, p: [x, y, 筆圧, x, y, 筆圧, …] }] }
// 座標はページ幅 1000 を基準にした値の 10 倍（整数）、筆圧は 100 倍（整数）で持つ。

/**
 * 手元の目次と Google ドライブ上の目次を比べ、受け取るものと送るものを決める。
 *   local:  { キー: { u, n } }     remote: { キー: { u, f: ファイルID } }
 */
export function mergeInkIndex(local, remote) {
  const download = [];
  const upload = [];
  for (const key of new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])) {
    if (!NOTE_KEY.test(key)) continue;
    const l = local?.[key]?.u || 0;
    const r = remote?.[key]?.u || 0;
    if (r > l && remote[key].f) download.push(key);
    else if (l > r) upload.push(key);
  }
  return { download, upload };
}

/** 線が描かれている範囲 [x0, y0, x1, y1]（ページの座標）。何もなければ null */
export function inkBounds(doc) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const stroke of doc?.strokes || []) {
    for (let i = 0; i + 2 < stroke.p.length; i += 3) {
      const x = stroke.p[i] / 10;
      const y = stroke.p[i + 1] / 10;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/** 1 本の線を SVG の path（d 属性）にする。小さなプレビュー用で、筆圧による太さの変化は省く */
export function strokePath(stroke) {
  const p = stroke.p;
  const n = Math.floor(p.length / 3);
  if (!n) return '';
  const pt = i => [p[i * 3] / 10, p[i * 3 + 1] / 10];
  const f = v => Math.round(v * 10) / 10;
  const [sx, sy] = pt(0);
  if (n === 1) return `M${f(sx)} ${f(sy)}l0.1 0`;
  let d = `M${f(sx)} ${f(sy)}`;
  for (let i = 1; i < n - 1; i++) {
    const [cx, cy] = pt(i);
    const [nx, ny] = pt(i + 1);
    d += `Q${f(cx)} ${f(cy)} ${f((cx + nx) / 2)} ${f((cy + ny) / 2)}`;
  }
  const [ex, ey] = pt(n - 1);
  return `${d}L${f(ex)} ${f(ey)}`;
}

/** 消しゴム: (x, y) から半径 r 以内を通る線を除いた配列を返す。変化がなければ元の配列をそのまま返す */
export function eraseStrokes(strokes, x, y, r) {
  const hit = stroke => {
    const p = stroke.p;
    const reach = r + stroke.w;
    for (let i = 0; i + 2 < p.length; i += 3) {
      const ax = p[i] / 10;
      const ay = p[i + 1] / 10;
      if (i + 5 >= p.length) return Math.hypot(ax - x, ay - y) <= reach;
      // 点と点の間（線分）との距離で判定する
      const bx = p[i + 3] / 10;
      const by = p[i + 4] / 10;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
      if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= reach) return true;
    }
    return false;
  };
  const kept = strokes.filter(s => !hit(s));
  return kept.length === strokes.length ? strokes : kept;
}

/**
 * 書き終えた線をなめらかに整える。各点を前後の点となじませて、ペン位置の細かな揺れ（ガタつき）を取る。
 * 線の両端と、向きが大きく変わる点（文字の角・折り返し）は動かさない。
 *   p: [x, y, 筆圧, x, y, 筆圧, …]（整数）。新しい配列を返す
 */
export function smoothStroke(p, passes = 2) {
  const n = Math.floor(p.length / 3);
  if (n < 5) return p;
  let cur = p;
  for (let pass = 0; pass < passes; pass++) {
    const out = cur.slice();
    for (let i = 1; i < n - 1; i++) {
      // 角かどうかは、少し離れた点どうしの向きで判定する（隣どうしだと揺れを角と見間違える）
      const a = Math.max(i - 3, 0) * 3;
      const b = Math.min(i + 3, n - 1) * 3;
      const c = i * 3;
      const inX = cur[c] - cur[a];
      const inY = cur[c + 1] - cur[a + 1];
      const outX = cur[b] - cur[c];
      const outY = cur[b + 1] - cur[c + 1];
      const inLen = Math.hypot(inX, inY);
      const outLen = Math.hypot(outX, outY);
      if (inLen && outLen && (inX * outX + inY * outY) / (inLen * outLen) < 0.5) continue; // 60 度以上の折れは角として残す
      for (let k = 0; k < 3; k++) out[c + k] = Math.round((cur[c - 3 + k] + 2 * cur[c + k] + cur[c + 3 + k]) / 4);
    }
    cur = out;
  }
  return cur;
}
