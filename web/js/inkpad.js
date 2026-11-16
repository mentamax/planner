// 手書き用のキャンバス。Apple Pencil・指・マウスの動きを線として記録し、描画する。
// 標準の Pointer Events だけを使う。キャンバス上ではブラウザのスクロールを止め（CSS の touch-action: none）、
// ペン・指・マウスの役割をここで振り分ける（下の「ペン・指・マウスの振り分け」を参照）。
import { PAGE_W, PAGE_H_MAX } from './ink.js';
import { eraseStrokes } from './model.js';

export const COLORS = ['#22211e', '#1f5fd0', '#d0352b', '#2a8a55'];
export const COLOR_NAMES = ['黒', '青', '赤', '緑'];
export const WIDTHS = [2.4, 5];

/** いま選んでいる道具（ノート画面のツールバーが書き換える） */
export const tool = { mode: 'pen', color: 0, width: 0, finger: false };

const RULE_GAP = 52; // 罫線の間隔
const RULE_COLOR = '#e8e2d3';
const ERASER_RADIUS = 12;
const PAGE_STEP = 650; // 「ページを伸ばす」で増える高さ
const MIN_STEP2 = 9; // これより近い点は記録しない（座標は 10 倍の整数。ページ幅 1000 に対して 0.3 未満の動き）
const HISTORY_MAX = 50;
const CORNER_COS = 0.35; // 向きの変化がこれより急（約 70 度以上の折れ）なら角として扱う
const PEN_QUIET_MS = 1000; // ペンを離してからこの時間は、触れた手を無視する
const PAN_START_PX = 10; // これ以上動いたらスクロール開始

const PEN_KEY = `${globalThis.PLANNER_NS || 'planner'}.pen`;
/** この端末でペン（Apple Pencil など）を使ったことがあるか。あれば指 1 本では反応させない */
export const pen = { seen: localStorage.getItem(PEN_KEY) === '1' };

export function createInkPad({ onChange, onState, onPen }) {
  // 2 枚重ね: base = 書き終えた線と罫線、live = いま書いている線の先端（次の点が来るたびに描き直す部分）
  const el = document.createElement('div');
  el.className = 'ink-canvas';
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', '手書きメモ');
  const base = document.createElement('canvas');
  const live = document.createElement('canvas');
  live.className = 'ink-live';
  el.append(base, live);
  const bctx = base.getContext('2d');
  const lctx = live.getContext('2d');

  let doc = null; // { key, h, strokes }
  let unit = 1; // ページ座標 1 あたりのキャンバスのピクセル数
  let history = []; // 元に戻す用。変更前の strokes 配列を積む（線は書き終えたら変更しない）
  let drawing = null; // { id, stroke }
  let erasing = null; // { id, before }
  let pan = null; // { id, scroller, y, t, v }
  let momentum = 0;
  let lastPen = 0;
  let liveBox = null; // live に描いてある範囲（次に消す場所）

  // ---- 描画 ----
  // 線は、記録した点を必ず通る曲線（Catmull-Rom）で結ぶ。角や細かい動きを丸めずに、書いたとおりの形にするため。

  const X = (p, i) => (p[i * 3] / 10) * unit;
  const Y = (p, i) => (p[i * 3 + 1] / 10) * unit;
  /** 筆圧 0.5 で指定の太さ。弱いと少し細く、強いと少し太く */
  const W = (s, i) => s.w * (0.7 + 0.6 * (s.p[i * 3 + 2] / 100)) * unit;

  function prepare(ctx, s) {
    ctx.strokeStyle = ctx.fillStyle = COLORS[s.c] || COLORS[0];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  /**
   * 点 i から点 i+1 までを描く。前後の点から曲がり具合を決める。
   * ・行き過ぎないよう、曲げる強さは区間の半分まで
   * ・急に向きが変わる点（文字の角・折り返し）では曲げず、角のまま残す
   */
  function segment(ctx, s, i) {
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
    /** 点（px, py）での曲げ方。in = そこへ入ってくる向き、out = 出ていく向き */
    const handle = (inX, inY, outX, outY) => {
      const a = Math.hypot(inX, inY);
      const b = Math.hypot(outX, outY);
      if (!a || !b || (inX * outX + inY * outY) / (a * b) < CORNER_COS) return [0, 0];
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
    ctx.lineWidth = (W(s, i) + W(s, i + 1)) / 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(x1 + ax, y1 + ay, x2 - bx, y2 - by, x2, y2);
    ctx.stroke();
  }

  function dot(ctx, s) {
    ctx.beginPath();
    ctx.arc(X(s.p, 0), Y(s.p, 0), Math.max(W(s, 0) / 2, 0.6), 0, Math.PI * 2);
    ctx.fill();
  }

  /** 線を描く。upTo を渡すと、その区間の手前まで（書いている途中の、形が確定した部分だけ） */
  function drawStroke(ctx, s, upTo) {
    const n = Math.floor(s.p.length / 3);
    if (!n) return;
    prepare(ctx, s);
    if (n === 1) return dot(ctx, s);
    const end = upTo ?? n - 1;
    for (let i = 0; i < end; i++) segment(ctx, s, i);
  }

  function clearLive() {
    if (!liveBox) return;
    lctx.clearRect(...liveBox);
    liveBox = null;
  }

  /** 書いている線の先端（最後の区間。次の点が来ると形が変わるので live 側に描く） */
  function drawTip() {
    clearLive();
    const s = drawing.stroke;
    const n = s.p.length / 3;
    prepare(lctx, s);
    if (n === 1) dot(lctx, s);
    else segment(lctx, s, n - 2);
    const i = Math.max(n - 2, 0);
    const pad = W(s, n - 1) + 4;
    const x0 = Math.min(X(s.p, i), X(s.p, n - 1)) - pad;
    const y0 = Math.min(Y(s.p, i), Y(s.p, n - 1)) - pad;
    liveBox = [x0, y0, Math.abs(X(s.p, i) - X(s.p, n - 1)) + pad * 2, Math.abs(Y(s.p, i) - Y(s.p, n - 1)) + pad * 2];
  }

  function redraw() {
    bctx.clearRect(0, 0, base.width, base.height);
    lctx.clearRect(0, 0, live.width, live.height);
    liveBox = null;
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
      const n = drawing.stroke.p.length / 3;
      if (n > 2) drawStroke(bctx, drawing.stroke, n - 2);
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
    for (const c of [base, live]) {
      if (c.width !== width || c.height !== height) {
        c.width = width;
        c.height = height;
      }
    }
    shownWidth = cssWidth;
    unit = width / PAGE_W;
    redraw();
  }
  new ResizeObserver(() => el.clientWidth !== shownWidth && resize()).observe(el);

  // ---- 入力 ----

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /** 画面上の位置 → 記録する [x, y, 筆圧]（整数）。縦も横も「表示幅 = ページ幅 1000」の同じ縮尺で換算する */
  function point(e) {
    const r = el.getBoundingClientRect();
    const k = PAGE_W / r.width;
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return [
      Math.round(clamp((e.clientX - r.left) * k, 0, PAGE_W) * 10),
      Math.round(clamp((e.clientY - r.top) * k, 0, doc.h) * 10),
      Math.round(clamp(pressure, 0.05, 1) * 100),
    ];
  }

  /** 1 回の通知にまとめられた細かい動き（Apple Pencil は画面の更新より速く位置を送ってくる）を取り出す */
  function samples(e) {
    const list = e.getCoalescedEvents?.() || [];
    const usable = list.length > 1 && list.every(v => Number.isFinite(v.clientX) && (v.clientX !== 0 || v.clientY !== 0));
    return usable ? list : [e];
  }

  function addPoint(e) {
    const s = drawing.stroke;
    const next = point(e);
    const dx = next[0] - s.p[s.p.length - 3];
    const dy = next[1] - s.p[s.p.length - 2];
    if (dx * dx + dy * dy < MIN_STEP2) return false;
    s.p.push(...next);
    // 形が確定した区間（2 つ前の点まで）を base に描き足す。先端は live に描き直す
    const n = s.p.length / 3;
    if (n >= 3) {
      prepare(bctx, s);
      segment(bctx, s, n - 3);
    }
    return true;
  }

  function startStroke(e) {
    drawing = { id: e.pointerId, stroke: { c: tool.color, w: WIDTHS[tool.width] || WIDTHS[0], p: point(e) } };
    drawTip();
  }

  /** 書いている線を確定する */
  function commitStroke() {
    const s = drawing.stroke;
    const n = s.p.length / 3;
    clearLive();
    prepare(bctx, s);
    if (n === 1) dot(bctx, s);
    else segment(bctx, s, n - 2);
    remember(doc.strokes);
    doc.strokes = [...doc.strokes, s];
    drawing = null;
    changed();
  }

  function eraseAt(e) {
    const [x, y] = point(e);
    const next = eraseStrokes(doc.strokes, x / 10, y / 10, ERASER_RADIUS);
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
  let lockTimer = 0;
  const penBusy = () => !!(drawing || erasing) || Date.now() - lastPen < PEN_QUIET_MS;

  /** ペンで書いている間とその直後は、ページ全体のスクロールも止める（手が余白に触れても動かないように） */
  function lockScroll(on) {
    clearTimeout(lockTimer);
    if (on) document.documentElement.classList.add('ink-writing');
    else lockTimer = setTimeout(() => document.documentElement.classList.remove('ink-writing'), PEN_QUIET_MS);
  }

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
    if (e.pointerType === 'pen') {
      sawPen();
      lockScroll(true);
    }
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
      let added = false;
      for (const ev of samples(e)) added = addPoint(ev) || added;
      if (added) drawTip();
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
      if (e.pointerType === 'pen') {
        lastPen = Date.now();
        lockScroll(false);
      }
      if (e.type === 'pointerup') addPoint(e); // 離した位置まで線を届かせる
      commitStroke();
    } else if (erasing?.id === e.pointerId) {
      if (e.pointerType === 'pen') {
        lastPen = Date.now();
        lockScroll(false);
      }
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
