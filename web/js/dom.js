// 最小限の描画まわり。状態が変わるたびに画面を作り直し、入力中のカーソルやスクロール位置は引き継ぐ。

/** 要素を作る。h('div', { class: 'a', onclick: fn }, 子...) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let lateValue;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' && tag === 'select') lateValue = v; // option を入れてから選ぶ
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  if (lateValue !== undefined) el.value = lateValue;
  return el;
}

function append(el, child) {
  if (child == null || child === false || child === true) return;
  if (Array.isArray(child)) child.forEach(c => append(el, c));
  else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
}

// 日本語入力の変換中・マウスのボタンを押している間・ドラッグ中は描き直しを待つ
// （変換が確定前に消えたり、クリックやドロップが空振りしたりするのを防ぐ）。
let composing = false;
let pointerDown = false;
let dragging = false;
const waiting = new Set();
const busy = () => composing || pointerDown || dragging;
const release = () =>
  setTimeout(() => {
    if (busy()) return;
    const mounts = [...waiting];
    waiting.clear();
    mounts.forEach(m => m.update());
  }, 0);

document.addEventListener('compositionstart', () => (composing = true), true);
document.addEventListener('compositionend', () => ((composing = false), release()), true);
document.addEventListener('pointerdown', () => (pointerDown = true), true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => ((pointerDown = false), release()), true);
}
// プルダウンや日付ピッカーは pointerup が届かないことがあるので、値の確定やキー操作でも解除する
for (const type of ['change', 'keydown']) {
  document.addEventListener(type, () => (pointerDown = false), true);
}
document.addEventListener('dragstart', () => (dragging = true), true);
for (const type of ['dragend', 'drop']) {
  document.addEventListener(type, () => ((dragging = false), (pointerDown = false), release()), true);
}
window.addEventListener('blur', () => ((pointerDown = false), (dragging = false), release()));

const isField = el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

function capture(root) {
  const snap = { focus: null, values: new Map(), scroll: new Map() };
  const a = document.activeElement;
  if (a && root.contains(a) && a.dataset.fk) {
    snap.focus = { fk: a.dataset.fk, value: isField(a) ? a.value : null, start: null, end: null };
    try {
      snap.focus.start = a.selectionStart;
      snap.focus.end = a.selectionEnd;
    } catch {
      /* 選択範囲を持たない入力欄 */
    }
  }
  root.querySelectorAll('[data-keep]').forEach(el => snap.values.set(el.dataset.fk, el.value));
  root.querySelectorAll('[data-sk]').forEach(el => snap.scroll.set(el.dataset.sk, [el.scrollTop, el.scrollLeft, el.dataset.skKey]));
  return snap;
}

function restore(root, snap) {
  root.querySelectorAll('[data-keep]').forEach(el => {
    const v = snap.values.get(el.dataset.fk);
    if (v != null) el.value = v;
  });
  root.querySelectorAll('[data-sk]').forEach(el => {
    const s = snap.scroll.get(el.dataset.sk);
    const d = el.dataset;
    const offset = Number(d.skInitOffset) || 0;
    // 初めて表示するときは決められた位置から始める（skInit = 縦位置、skInitTop / skInitLeft = その要素が見える位置）
    if (s) el.scrollTop = s[0];
    else if (d.skInit) el.scrollTop = Number(d.skInit);
    else if (d.skInitTop) el.scrollTop = Math.max(0, (el.querySelector(d.skInitTop)?.offsetTop ?? 0) - offset);
    // 横位置は、skKey（表示中の週など）が変わったら決め直す
    if (s && s[2] === d.skKey) el.scrollLeft = s[1];
    else if (d.skInitLeft) el.scrollLeft = Math.max(0, (el.querySelector(d.skInitLeft)?.offsetLeft ?? 0) - offset);
  });
  if (!snap.focus) return;
  const el = [...root.querySelectorAll('[data-fk]')].find(e => e.dataset.fk === snap.focus.fk);
  if (!el) return;
  // 値そのものは data-keep の欄だけ引き継ぐ（上で復元済み）。メモ欄などは状態の内容を表示する
  el.focus({ preventScroll: true });
  try {
    if (snap.focus.start != null) el.setSelectionRange(snap.focus.start, snap.focus.end);
  } catch {
    /* 選択範囲を持たない入力欄 */
  }
}

/**
 * container に renderFn() の結果を表示する。update() を呼ぶと次のタイミングで描き直す。
 * data-fk: フォーカスを引き継ぐ要素のキー / data-keep: 入力中の値を引き継ぐ / data-sk: スクロール位置を引き継ぐ
 */
export function mount(container, renderFn) {
  let scheduled = false;
  let dead = false;

  function render() {
    scheduled = false;
    if (dead) return;
    if (busy()) {
      waiting.add(api);
      return;
    }
    const snap = capture(container);
    container.replaceChildren(renderFn());
    restore(container, snap);
  }

  const api = {
    update() {
      if (scheduled || dead) return;
      scheduled = true;
      queueMicrotask(render);
    },
    destroy() {
      dead = true;
      waiting.delete(api);
      container.replaceChildren();
    },
  };
  render();
  return api;
}
