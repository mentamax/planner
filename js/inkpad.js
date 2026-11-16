// 手書き用のキャンバス。Apple Pencil・指・マウスの動きを線として記録し、描画する。
// 標準の Pointer Events だけを使う。キャンバス上ではブラウザのスクロールを止め（CSS の touch-action: none）、
// ペン・指・マウスの役割をここで振り分ける（下の「ペン・指・マウスの振り分け」を参照）。
import { PAGE_W, PAGE_H_MAX } from './ink.js';
import { eraseStrokes, smoothStroke } from './model.js';

export const COLORS = ['#22211e', '#1f5fd0', '#d0352b', '#2a8a55'];
export const COLOR_NAMES = ['黒', '青', '赤', '緑'];
export const WIDTHS = [3, 6]; // ペンの太さ（ページ幅 1000 に対する値）

/** いま選んでいる道具（ノート画面のツールバーが書き換える） */
export const tool = { mode: 'pen', color: 0, width: 0, finger: false };

const RULE_GAP = 52; // 罫線の間隔
const RULE_COLOR = '#e8e2d3';
const ERASER_RADIUS = 12;
const PAGE_STEP = 650; // 「ページを伸ばす」で増える高さ
const MIN_STEP_PX = 1; // 点を記録する最小の間隔（画面上のピクセル）
const SMOOTH_MS = 4; // ペン位置をなじませる時間の幅（ミリ秒）。大きいほど揺れは減るが、角が丸くなる
const CORNER_MIN_LEN = 3; // 角として扱うのは、前後の点がこれ以上離れているときだけ（ページ座標）
const HISTORY_MAX = 50;
const PREDICT_MAX = 2; // 先読みを使う点の数
const CORNER_COS = 0.35; // 向きの変化がこれより急（約 70 度以上の折れ）なら角として扱う
const PEN_QUIET_MS = 1000; // ペンを離してからこの時間は、触れた手を無視する
const PAN_START_PX = 10; // これ以上動いたらスクロール開始

const PEN_KEY = `${globalThis.PLANNER_NS || 'planner'}.pen`;
/** この端末でペン（Apple Pencil など）を使ったことがあるか。あれば指 1 本では反応させない */
export const pen = { seen: localStorage.getItem(PEN_KEY) === '1' };

export function createInkPad({ onChange, onState, onPen }) {
  // 3 枚重ね:
  //   base = 書き終えた線と罫線
  //   live = いま書いている線のうち、形が確定した部分（書き終えたら base にきれいに描き直して消す）
  //   tip  = いま書いている線の先端と先読み（通知のたびに描き直す）
  const el = document.createElement('div');
  el.className = 'ink-canvas';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', '手書きメモ');
  const base = document.createElement('canvas');
  const live = document.createElement('canvas');
  const tip = document.createElement('canvas');
  live.className = tip.className = 'ink-live';
  el.append(base, live, tip);
  const bctx = base.getContext('2d');
  const lctx = live.getContext('2d');
  const tctx = tip.getContext('2d');

  let doc = null; // { key, h, strokes }
  let unit = 1; // ページ座標 1 あたりのキャンバスのピクセル数
  let minStep2 = 100; // これより近い点は記録しない（座標 10 倍の整数での距離の 2 乗。表示サイズから決める）
  let history = []; // 元に戻す用。変更前の strokes 配列を積む（線は書き終えたら変更しない）
  let drawing = null; // 書いている線。{ id, stroke, ahead, sx, sy, sp, rx, ry, lastT }
  let erasing = null; // { id, before }
  let pan = null; // { id, scroller, y, t, v }
  let momentum = 0;
  let lastPen = 0;
  let tipBox = null; // tip に描いてある範囲（次に消す場所）

  // ---- 描画 ----
  // 線は、記録した点を通るなめらかな曲線（Catmull-Rom）で結ぶ。

  const X = (p, i) => (p[i * 3] / 10) * unit;
  const Y = (p, i) => (p[i * 3 + 1] / 10) * unit;
  /** 太さ。軽く書いても細くなりすぎないよう、筆圧の影響はゆるやかにする（筆圧 0.25 で指定の太さ） */
  const W = (s, i) => s.w * (0.8 + 0.4 * Math.sqrt(s.p[i * 3 + 2] / 100)) * unit;
  const segmentWidth = (s, i) => (W(s, i) + W(s, i + 1)) / 2;
  /** 太さを 0.25px 刻みにそろえる（ほぼ同じ太さの区間を、ひと続きの線として描くため） */
  const bucket = w => Math.max(0.5, Math.round(w * 4) / 4);

  function prepare(ctx, s) {
    ctx.strokeStyle = ctx.fillStyle = COLORS[s.c] || COLORS[0];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /**
   * 点 i から点 i+1 までの曲線（3 次ベジェ）の制御点と終点 [c1x, c1y, c2x, c2y, x2, y2] を返す。
   * ・行き過ぎないよう、曲げる強さは区間の半分まで
   * ・間隔の空いた点どうしで急に向きが変わるところ（文字の角・折り返し）は、曲げずに角のまま残す
   */
  function curve(s, i) {
    const p = s.p;
    const n = p.length / 3;
    const x1 = X(p, i);
    const y1 = Y(p, i);
    const x2 = X(p, i + 1);
    const y2 = Y(p, i + 1);
    const before = Math.max(i - 1, 0);
    const after = Math.min(i + 2, n - 1);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy);
    const cornerMin = CORNER_MIN_LEN * unit;
    const handle = (inX, inY, outX, outY) => {
      const a = Math.hypot(inX, inY);
      const b = Math.hypot(outX, outY);
      if (!a || !b) return [0, 0];
      if (a >= cornerMin && b >= cornerMin && (inX * outX + inY * outY) / (a * b) < CORNER_COS) return [0, 0];
      let hx = (inX + outX) / 6;
      let hy = (inY + outY) / 6;
      const h = Math.hypot(hx, hy);
      if (h > len / 2 && h > 0) {
        hx *= len / 2 / h;
        hy *= len / 2 / h;
      }
      return [hx, hy];
    };
    const [ax, ay] = handle(x1 - X(p, before), y1 - Y(p, before), dx, dy);
    const [bx, by] = handle(dx, dy, X(p, after) - x2, Y(p, after) - y2);
    return [x1 + ax, y1 + ay, x2 - bx, y2 - by, x2, y2];
  }

  /** 区間 1 つ分を描く（書いている最中の描き足し用） */
  function segment(ctx, s, i) {
    ctx.lineWidth = segmentWidth(s, i);
    ctx.beginPath();
    ctx.moveTo(X(s.p, i), Y(s.p, i));
    ctx.bezierCurveTo(...curve(s, i));
    ctx.stroke();
  }

  function dot(ctx, s) {
    ctx.beginPath();
    ctx.arc(X(s.p, 0), Y(s.p, 0), Math.max(W(s, 0) / 2, 0.6), 0, Math.PI * 2);
    ctx.fill();
  }

  /**
   * 線全体を描く。太さがほぼ同じ区間はひと続きの線として描く
   * （区間ごとに描くと、つなぎ目が重なって縁が荒れ、線がガタついて見える）。
   */
  function drawStroke(ctx, s) {
    const n = Math.floor(s.p.length / 3);
    if (!n) return;
    prepare(ctx, s);
    if (n === 1) return dot(ctx, s);
    let i = 0;
    while (i < n - 1) {
      const width = bucket(segmentWidth(s, i));
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(X(s.p, i), Y(s.p, i));
      do {
        ctx.bezierCurveTo(...curve(s, i));
        i++;
      } while (i < n - 1 && bucket(segmentWidth(s, i)) === width);
      ctx.stroke();
    }
  }

  function clearTip() {
    if (!tipBox) return;
    tctx.clearRect(...tipBox);
    tipBox = null;
  }

  /**
   * 書いている線の先端を tip に描く。最後の区間（次の点が来ると形が変わる）と、
   * ブラウザが予測した少し先の位置（対応している場合）。予測分は記録せず、次の通知で描き直す。
   */
  function drawTip() {
    clearTip();
    const s = drawing.stroke;
    const p = s.p;
    const n = p.length / 3;
    prepare(tctx, s);
    if (n === 1) dot(tctx, s);
    else segment(tctx, s, n - 2);
    const first = Math.max(n - 2, 0);
    let x0 = Math.min(X(p, first), X(p, n - 1));
    let y0 = Math.min(Y(p, first), Y(p, n - 1));
    let x1 = Math.max(X(p, first), X(p, n - 1));
    let y1 = Math.max(Y(p, first), Y(p, n - 1));
    // 記録済みの最後の点 → なめらかにする前の実際のペン位置 → 予測した位置、の順に結ぶ
    const ahead = [drawing.rx * unit, drawing.ry * unit, ...drawing.ahead.map(v => v * unit)];
    tctx.lineWidth = W(s, n - 1);
    tctx.beginPath();
    tctx.moveTo(X(p, n - 1), Y(p, n - 1));
    for (let i = 0; i < ahead.length; i += 2) {
      tctx.lineTo(ahead[i], ahead[i + 1]);
      x0 = Math.min(x0, ahead[i]);
      y0 = Math.min(y0, ahead[i + 1]);
      x1 = Math.max(x1, ahead[i]);
      y1 = Math.max(y1, ahead[i + 1]);
    }
    tctx.stroke();
    const pad = W(s, n - 1) + 4;
    tipBox = [x0 - pad, y0 - pad, x1 - x0 + pad * 2, y1 - y0 + pad * 2];
  }

  function redraw() {
    bctx.clearRect(0, 0, base.width, base.height);
    lctx.clearRect(0, 0, live.width, live.height);
    tctx.clearRect(0, 0, tip.width, tip.height);
    tipBox = null;
    if (!doc) return;
    bctx.strokeStyle = RULE_COLOR;
    bctx.lineWidth = Math.max(1, unit);
    bctx.beginPath();
    for (let y = RULE_GAP; y < doc.h; y += RULE_GAP) {
      bctx.moveTo(0, Math.round(y * unit) + 0.5);
      bctx.lineTo(base.width, Math.round(y * unit) + 0.5);
    }
    bctx.stroke();
    doc.strokes.forEach(s => drawStroke(bctx, s));
    if (drawing) {
      const s = drawing.stroke;
      prepare(lctx, s);
      for (let i = 0; i < s.p.length / 3 - 2; i++) segment(lctx, s, i);
      drawTip();
    }
  }

  /**
   * 表示サイズに合わせてキャンバスの大きさと解像度を決め直す。
   * 高さは幅から計算して px で指定する（縦と横の縮尺が必ず同じになり、ペン先と線がずれない）。
   */
  let shownWidth = 0;
  function resize() {
    if (!el.isConnected) return;
    const cssWidth = el.clientWidth;
    if (!cssWidth) return;
    const pageH = doc ? doc.h : 400;
    const cssHeight = Math.round((cssWidth * pageH) / PAGE_W);
    el.style.height = `${cssHeight}px`;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(cssHeight * dpr);
    for (const c of [base, live, tip]) {
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
    }
    shownWidth = cssWidth;
    unit = width / PAGE_W;
    // 点の間隔は、画面上で約 MIN_STEP_PX ピクセル。これより細かく記録しても、検出の揺れを拾うだけになる
    const step = ((MIN_STEP_PX * PAGE_W) / cssWidth) * 10;
    minStep2 = step * step;
    redraw();
  }
  new ResizeObserver(() => el.clientWidth !== shownWidth && resize()).observe(el);

  // ---- 入力 ----

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /** 画面上の位置 → ページ座標 [x, y]。縦も横も「表示幅 = ページ幅 1000」の同じ縮尺で換算する */
  function locate(e) {
    const r = el.getBoundingClientRect();
    const k = PAGE_W / r.width;
    return [clamp((e.clientX - r.left) * k, 0, PAGE_W), clamp((e.clientY - r.top) * k, 0, doc.h)];
  }

  /** ペンは筆圧をそのまま使う。筆圧 0 で届く通知（離す瞬間など）は、直前の値を引き継ぐ */
  const pressureOf = (e, prev) => (e.pointerType === 'pen' ? (e.pressure > 0 ? clamp(e.pressure, 0.01, 1) : prev) : 0.5);

  /** 1 回の通知にまとめられた細かい動き（Apple Pencil は画面の更新より速く位置を送ってくる）を取り出す */
  function samples(e) {
    const list = e.getCoalescedEvents?.() || [];
    const usable = list.length > 1 && list.every(v => Number.isFinite(v.clientX) && (v.clientX !== 0 || v.clientY !== 0));
    return usable ? list : [e];
  }

  /**
   * ペン位置を 1 つ取り込む。
   * 1 秒に数百回届く位置には検出の細かな揺れが乗っているので、直前までの位置となじませてから（数ミリ秒分の平均）、
   * 画面上で一定以上動いたときだけ点として記録する。
   */
  function addPoint(e) {
    const d = drawing;
    const t = e.timeStamp || 0;
    if (t && d.lastT && t < d.lastT) {
      if (live1) live1.backwards++;
      return false; // 順序が前後して届いた位置は使わない
    }
    const dt = t > d.lastT ? Math.max(1, t - d.lastT) : 2; // 時刻が同じ・不明のときは 2ms 間隔とみなす
    if (t) d.lastT = t;
    const [x, y] = locate(e);
    const k = 1 - Math.exp(-dt / SMOOTH_MS);
    d.rx = x;
    d.ry = y;
    d.sx += (x - d.sx) * k;
    d.sy += (y - d.sy) * k;
    d.sp += (pressureOf(e, d.sp) - d.sp) * k;
    const p = d.stroke.p;
    const nx = Math.round(d.sx * 10);
    const ny = Math.round(d.sy * 10);
    const dx = nx - p[p.length - 3];
    const dy = ny - p[p.length - 2];
    if (dx * dx + dy * dy < minStep2) return false;
    p.push(nx, ny, Math.round(d.sp * 100));
    // 形が確定した区間（2 つ前の点まで）を live に描き足す。先端は tip に描き直す
    const n = p.length / 3;
    if (n >= 3) {
      prepare(lctx, d.stroke);
      segment(lctx, d.stroke, n - 3);
    }
    return true;
  }

  function startStroke(e) {
    const [x, y] = locate(e);
    const pressure = pressureOf(e, 0.2);
    drawing = {
      id: e.pointerId,
      stroke: { c: tool.color, w: WIDTHS[tool.width] || WIDTHS[0], p: [Math.round(x * 10), Math.round(y * 10), Math.round(pressure * 100)] },
      ahead: [],
      sx: x,
      sy: y,
      sp: pressure,
      rx: x,
      ry: y,
      lastT: e.timeStamp || 0,
    };
    live1 = { type: e.pointerType, t0: e.timeStamp, t1: e.timeStamp, moves: 0, samples: 0, lag: 0, pMin: 1, pMax: 0, predicted: false, backwards: 0 };
    drawTip();
  }

  // ---- 診断用の計測（ノートの「診断」表示で使う。書き心地に問題があるときの原因調べ用） ----

  let live1 = null; // いま書いている線の計測
  const recent = []; // 直近に書いた線の計測結果（新しい順・3 本まで）

  function measure(e, sampleCount) {
    if (!live1) return;
    live1.moves++;
    live1.samples += sampleCount;
    live1.t1 = e.timeStamp;
    live1.lag += Math.max(0, performance.now() - e.timeStamp);
    live1.pMin = Math.min(live1.pMin, e.pressure);
    live1.pMax = Math.max(live1.pMax, e.pressure);
    if (drawing?.ahead.length) live1.predicted = true;
  }

  function closeMeasure(points) {
    if (!live1) return;
    const seconds = Math.max(live1.t1 - live1.t0, 1) / 1000;
    recent.unshift({
      type: live1.type,
      ms: Math.round(seconds * 1000),
      movesPerSec: Math.round(live1.moves / seconds),
      samplesPerSec: Math.round(live1.samples / seconds),
      points,
      lagMs: live1.moves ? Math.round(live1.lag / live1.moves) : 0,
      pressure: [Math.round(live1.pMin * 100) / 100, Math.round(live1.pMax * 100) / 100],
      predicted: live1.predicted,
      perMove: live1.moves ? Math.round((live1.samples / live1.moves) * 10) / 10 : 0,
      backwards: live1.backwards,
    });
    recent.length = Math.min(recent.length, 3);
    live1 = null;
  }

  /** 書いている線を確定する。書いている最中の描画を消して、base にきれいな 1 本の線として描き直す */
  function commitStroke() {
    const d = drawing;
    const s = d.stroke;
    // ペンを離した位置まで線を届かせる（なじませた分だけ手前で止まっているため）
    const ex = Math.round(d.rx * 10);
    const ey = Math.round(d.ry * 10);
    const dx = ex - s.p[s.p.length - 3];
    const dy = ey - s.p[s.p.length - 2];
    if (dx * dx + dy * dy >= 9) s.p.push(ex, ey, s.p[s.p.length - 1]);
    // 書いている間は遅れないことを優先し、書き終えたところで線全体をなめらかに整える
    s.p = smoothStroke(s.p);
    lctx.clearRect(0, 0, live.width, live.height);
    clearTip();
    drawStroke(bctx, s);
    remember(doc.strokes);
    doc.strokes = [...doc.strokes, s];
    drawing = null;
    closeMeasure(s.p.length / 3);
    changed();
  }

  function eraseAt(e) {
    const [x, y] = locate(e);
    const next = eraseStrokes(doc.strokes, x, y, ERASER_RADIUS);
    if (next !== doc.strokes) {
      doc.strokes = next;
      redraw();
    }
  }

  function endErase() {
    const { before } = erasing;
    erasing = null;
    if (before !== doc.strokes) {
      remember(before);
      changed();
    }
  }

  function remember(before) {
    history.push(before);
    if (history.length > HISTORY_MAX) history.shift();
  }

  function changed() {
    onChange?.(doc);
    onState?.();
  }

  /** 指やペンがキャンバスの外へ出ても続きを受け取れるようにする（できない環境でも書けるよう、失敗は無視する） */
  function capture(e) {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* 取得できなくても、キャンバス上の動きは届く */
    }
  }

  // ---- ペン・指・マウスの振り分け ----
  //   ペン / マウス : 書く（または消す）
  //   指 : 「指で書く」がオンなら書く。オフのときは、
  //        ・ペンを使ったことがある端末 … 1 本指では何もしない（手のひらや指が触れても動かない）。スクロールは 2 本指
  //        ・ペンを使ったことがない端末 … 1 本指でスクロール

  const touches = new Map(); // いま触れている指（pointerId → 触れた時刻）
  const penBusy = () => !!(drawing || erasing) || Date.now() - lastPen < PEN_QUIET_MS;

  // ペンで書いている間とその直後は、手が触れてもページがスクロール・拡大しないようにする。
  // （書き始めのたびに画面の作りを切り替えると引っかかりの原因になるので、タッチの動きだけを無効にする）
  document.addEventListener(
    'touchmove',
    e => {
      if (el.isConnected && penBusy() && e.cancelable) e.preventDefault();
    },
    { passive: false },
  );

  function sawPen() {
    lastPen = Date.now();
    if (pen.seen) return;
    pen.seen = true;
    try {
      localStorage.setItem(PEN_KEY, '1');
    } catch {
      /* 覚えておけなくても、このページを開いている間は有効 */
    }
    onPen?.();
  }

  el.addEventListener('pointerdown', e => {
    if (!doc) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelAnimationFrame(momentum);

    if (e.pointerType === 'touch' && !tool.finger) {
      const now = Date.now();
      for (const [id, since] of touches) if (now - since > 60_000) touches.delete(id); // 離れたことを取りこぼした分を掃除
      touches.set(e.pointerId, now);
      capture(e);
      if (penBusy()) return; // 書いている最中・直後に触れた手は無視する
      if (touches.size === (pen.seen ? 2 : 1)) startPan(e);
      return;
    }
    // 前の線の「離した」を取りこぼしていても、次の線は必ず書き始められるようにする
    if (drawing) commitStroke();
    if (erasing) endErase();
    if (e.pointerType === 'pen') sawPen();
    pan = null;
    e.preventDefault();
    capture(e);
    if (tool.mode === 'eraser') {
      erasing = { id: e.pointerId, before: doc.strokes };
      eraseAt(e);
      return;
    }
    startStroke(e);
  });

  el.addEventListener('pointermove', e => {
    if (drawing?.id === e.pointerId) {
      if (e.pointerType === 'pen') lastPen = Date.now();
      const list = samples(e);
      let added = false;
      for (const ev of list) added = addPoint(ev) || added;
      // 先読みは 2 点まで使う（多く使うと、向きを変えたときに行き過ぎて見える）
      const predicted = e.getPredictedEvents?.() || [];
      drawing.ahead = predicted.slice(0, PREDICT_MAX).flatMap(ev => locate(ev));
      if (added || drawing.ahead.length) drawTip();
      measure(e, list.length);
    } else if (erasing?.id === e.pointerId) {
      for (const ev of samples(e)) eraseAt(ev);
    } else if (pan?.id === e.pointerId) {
      movePan(e);
    }
  });

  function finish(e) {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      // スクロール中の指が離れたか、2 本指のうち 1 本が離れたら終わり
      if (pan && (pan.id === e.pointerId || touches.size < (pen.seen ? 2 : 1))) endPan();
    }
    if (drawing?.id === e.pointerId) {
      if (e.pointerType === 'pen') lastPen = Date.now();
      commitStroke();
    } else if (erasing?.id === e.pointerId) {
      if (e.pointerType === 'pen') lastPen = Date.now();
      endErase();
    }
  }
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
  window.addEventListener('blur', () => touches.clear());

  // ---- 指でのスクロール（キャンバス上ではブラウザのスクロールが効かないので、ここで動かす） ----

  function startPan(e) {
    const scroller = el.closest('[data-ink-scroll]');
    if (!scroller) return;
    pan = { id: e.pointerId, scroller, y: e.clientY, y0: e.clientY, t: e.timeStamp, v: 0, moving: false };
  }
  function movePan(e) {
    if (penBusy()) {
      pan = null; // 書き始めたら、スクロールはやめる
      return;
    }
    // 触れただけ・わずかにずれただけでは動かさない
    if (!pan.moving && Math.abs(e.clientY - pan.y0) < PAN_START_PX) return;
    if (!pan.moving) {
      pan.moving = true;
      pan.y = e.clientY;
      pan.t = e.timeStamp;
      return;
    }
    const dy = e.clientY - pan.y;
    const dt = Math.max(1, e.timeStamp - pan.t);
    pan.scroller.scrollTop -= dy;
    pan.v = 0.7 * pan.v + 0.3 * (dy / dt);
    pan.y = e.clientY;
    pan.t = e.timeStamp;
  }
  function endPan() {
    const { scroller, moving } = pan;
    let v = pan.v * 16; // 1 フレームあたりの移動量
    pan = null;
    if (!moving) return;
    const step = () => {
      if (Math.abs(v) < 0.4) return;
      scroller.scrollTop -= v;
      v *= 0.95;
      momentum = requestAnimationFrame(step);
    };
    step();
  }

  // ---- 外から使う操作 ----

  return {
    el,
    /** 表示するページを切り替える。null で何も表示しない（読み込み中） */
    show(next) {
      doc = next ? { key: next.key, h: next.h, strokes: next.strokes } : null;
      history = [];
      drawing = erasing = pan = null;
      resize();
      if (!el.isConnected) redraw();
      onState?.();
    },
    get busy() {
      return !!(drawing || erasing);
    },
    get canUndo() {
      return history.length > 0;
    },
    get isEmpty() {
      return !doc?.strokes.length;
    },
    get canExtend() {
      return !!doc && doc.h < PAGE_H_MAX;
    },
    /** 診断表示用の情報 */
    diagnostics() {
      const proto = typeof PointerEvent === 'undefined' ? {} : PointerEvent.prototype;
      return {
        coalesced: 'getCoalescedEvents' in proto,
        predicted: 'getPredictedEvents' in proto,
        canvas: `${el.clientWidth}×${el.clientHeight}（内部 ${base.width}×${base.height}・倍率 ${window.devicePixelRatio}）`,
        strokes: doc?.strokes.length ?? 0,
        penSeen: pen.seen,
        recent: [...recent],
      };
    },
    undo() {
      if (!doc || !history.length) return;
      doc.strokes = history.pop();
      redraw();
      changed();
    },
    clear() {
      if (!doc?.strokes.length) return;
      remember(doc.strokes);
      doc.strokes = [];
      redraw();
      changed();
    },
    /** ページを下に伸ばす */
    extend() {
      if (!doc || doc.h >= PAGE_H_MAX) return;
      doc.h = Math.min(doc.h + PAGE_STEP, PAGE_H_MAX);
      resize();
      changed();
    },
  };
}
