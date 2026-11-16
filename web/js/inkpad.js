// 手書き用のキャンバス。Apple Pencil・指・マウスの動きを線として記録し、描画する。
// 標準の Pointer Events だけを使う。キャンバス上ではブラウザのスクロールを止め（CSS の touch-action: none）、
// 「ペン = 書く」「指 = スクロール（設定で書くにもできる）」をここで振り分ける。
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
const MIN_STEP2 = 64; // これより近い点は記録しない（座標は 10 倍の整数なので 0.8 の 2 乗 × 100）
const HISTORY_MAX = 50;

export function createInkPad({ onChange, onState }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'ink-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '手書きメモ');
  const ctx = canvas.getContext('2d');

  let doc = null; // { key, h, strokes }
  let unit = 1; // ページ座標 1 あたりのキャンバスのピクセル数
  let history = []; // 元に戻す用。変更前の strokes 配列を積む（線は書き終えたら変更しない）
  let drawing = null; // { id, stroke }
  let erasing = null; // { id, before }
  let pan = null; // { id, scroller, y, t, v }
  let momentum = 0;
  let lastPen = 0;

  // ---- 描画 ----

  const X = (p, i) => (p[i * 3] / 10) * unit;
  const Y = (p, i) => (p[i * 3 + 1] / 10) * unit;
  /** 筆圧 0.5 で指定の太さ。弱いと細く、強いと太く */
  const W = (s, i) => s.w * (0.45 + 1.1 * (s.p[i * 3 + 2] / 100)) * unit;

  function prepare(s) {
    ctx.strokeStyle = ctx.fillStyle = COLORS[s.c] || COLORS[0];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }

  // 線は「点と点の中点」を結ぶ曲線（各点を制御点にする）でなめらかにする
  function head(s) {
    const p = s.p;
    ctx.lineWidth = W(s, 0);
    ctx.beginPath();
    ctx.moveTo(X(p, 0), Y(p, 0));
    ctx.lineTo((X(p, 0) + X(p, 1)) / 2, (Y(p, 0) + Y(p, 1)) / 2);
    ctx.stroke();
  }
  function piece(s, i) {
    const p = s.p;
    ctx.lineWidth = W(s, i);
    ctx.beginPath();
    ctx.moveTo((X(p, i - 1) + X(p, i)) / 2, (Y(p, i - 1) + Y(p, i)) / 2);
    ctx.quadraticCurveTo(X(p, i), Y(p, i), (X(p, i) + X(p, i + 1)) / 2, (Y(p, i) + Y(p, i + 1)) / 2);
    ctx.stroke();
  }
  function tail(s) {
    const p = s.p;
    const n = p.length / 3;
    ctx.lineWidth = W(s, n - 1);
    ctx.beginPath();
    ctx.moveTo((X(p, n - 2) + X(p, n - 1)) / 2, (Y(p, n - 2) + Y(p, n - 1)) / 2);
    ctx.lineTo(X(p, n - 1), Y(p, n - 1));
    ctx.stroke();
  }
  function dot(s) {
    ctx.beginPath();
    ctx.arc(X(s.p, 0), Y(s.p, 0), Math.max(W(s, 0) / 2, 0.6), 0, Math.PI * 2);
    ctx.fill();
  }

  function drawStroke(s) {
    const n = Math.floor(s.p.length / 3);
    if (!n) return;
    prepare(s);
    if (n === 1) return dot(s);
    head(s);
    for (let i = 1; i < n - 1; i++) piece(s, i);
    tail(s);
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!doc) return;
    ctx.strokeStyle = RULE_COLOR;
    ctx.lineWidth = Math.max(1, unit);
    ctx.beginPath();
    for (let y = RULE_GAP; y < doc.h; y += RULE_GAP) {
      ctx.moveTo(0, Math.round(y * unit) + 0.5);
      ctx.lineTo(canvas.width, Math.round(y * unit) + 0.5);
    }
    ctx.stroke();
    doc.strokes.forEach(drawStroke);
    if (drawing) drawStroke(drawing.stroke);
  }

  /** 表示サイズに合わせてキャンバスの解像度を決め直す */
  function resize() {
    if (!doc || !canvas.isConnected) return;
    const cssWidth = canvas.clientWidth;
    if (!cssWidth) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = Math.round(cssWidth * dpr);
    const height = Math.round(((cssWidth * doc.h) / PAGE_W) * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    unit = width / PAGE_W;
    redraw();
  }
  new ResizeObserver(resize).observe(canvas);

  // ---- 入力 ----

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  /** 画面上の位置 → 記録する [x, y, 筆圧]（整数） */
  function point(e) {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * PAGE_W;
    const y = ((e.clientY - r.top) / r.height) * doc.h;
    const pressure = e.pointerType === 'pen' && e.pressure > 0 ? e.pressure : 0.5;
    return [Math.round(clamp(x, 0, PAGE_W) * 10), Math.round(clamp(y, 0, doc.h) * 10), Math.round(clamp(pressure, 0.05, 1) * 100)];
  }

  function addPoint(e) {
    const p = drawing.stroke.p;
    const next = point(e);
    const dx = next[0] - p[p.length - 3];
    const dy = next[1] - p[p.length - 2];
    if (dx * dx + dy * dy < MIN_STEP2) return;
    p.push(...next);
    // 増えた分だけ描き足す（毎回すべてを描き直さない）
    const n = p.length / 3;
    prepare(drawing.stroke);
    if (n === 2) head(drawing.stroke);
    else piece(drawing.stroke, n - 2);
    tail(drawing.stroke);
  }

  function eraseAt(e) {
    const [x, y] = point(e);
    const next = eraseStrokes(doc.strokes, x / 10, y / 10, ERASER_RADIUS);
    if (next !== doc.strokes) {
      doc.strokes = next;
      redraw();
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
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* 取得できなくても、キャンバス上の動きは届く */
    }
  }

  canvas.addEventListener('pointerdown', e => {
    if (!doc || drawing || erasing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelAnimationFrame(momentum);
    if (e.pointerType === 'pen') lastPen = Date.now();

    if (e.pointerType === 'touch' && !tool.finger) {
      // 指はスクロール。ペンで書いている最中や直後に触れた手のひらは無視する
      if (Date.now() - lastPen > 1200) startPan(e);
      return;
    }
    pan = null;
    e.preventDefault();
    capture(e);
    if (tool.mode === 'eraser') {
      erasing = { id: e.pointerId, before: doc.strokes };
      eraseAt(e);
      return;
    }
    drawing = { id: e.pointerId, stroke: { c: tool.color, w: WIDTHS[tool.width] || WIDTHS[0], p: point(e) } };
    prepare(drawing.stroke);
    dot(drawing.stroke);
  });

  canvas.addEventListener('pointermove', e => {
    if (drawing?.id === e.pointerId) {
      if (e.pointerType === 'pen') lastPen = Date.now();
      const events = e.getCoalescedEvents?.() || [];
      for (const ev of events.length ? events : [e]) addPoint(ev);
    } else if (erasing?.id === e.pointerId) {
      eraseAt(e);
    } else if (pan?.id === e.pointerId) {
      movePan(e);
    }
  });

  function finish(e) {
    if (drawing?.id === e.pointerId) {
      if (e.pointerType === 'pen') lastPen = Date.now();
      remember(doc.strokes);
      doc.strokes = [...doc.strokes, drawing.stroke];
      drawing = null;
      changed();
    } else if (erasing?.id === e.pointerId) {
      const { before } = erasing;
      erasing = null;
      if (before !== doc.strokes) {
        remember(before);
        changed();
      }
    } else if (pan?.id === e.pointerId) {
      endPan();
    }
  }
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);

  // ---- 指でのスクロール（キャンバス上ではブラウザのスクロールが効かないので、ここで動かす） ----

  function startPan(e) {
    const scroller = canvas.closest('[data-ink-scroll]');
    if (!scroller) return;
    pan = { id: e.pointerId, scroller, y: e.clientY, t: e.timeStamp, v: 0 };
    capture(e);
  }
  function movePan(e) {
    const dy = e.clientY - pan.y;
    const dt = Math.max(1, e.timeStamp - pan.t);
    pan.scroller.scrollTop -= dy;
    pan.v = 0.7 * pan.v + 0.3 * (dy / dt);
    pan.y = e.clientY;
    pan.t = e.timeStamp;
  }
  function endPan() {
    const { scroller } = pan;
    let v = pan.v * 16; // 1 フレームあたりの移動量
    pan = null;
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
    el: canvas,
    /** 表示するページを切り替える。null で何も表示しない（読み込み中） */
    show(next) {
      doc = next ? { key: next.key, h: next.h, strokes: next.strokes } : null;
      history = [];
      drawing = erasing = pan = null;
      canvas.style.aspectRatio = doc ? `${PAGE_W} / ${doc.h}` : `${PAGE_W} / 600`;
      if (doc) resize();
      else redraw();
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
      canvas.style.aspectRatio = `${PAGE_W} / ${doc.h}`;
      resize();
      changed();
    },
  };
}
