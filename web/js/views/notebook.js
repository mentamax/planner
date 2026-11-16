// ノート。日・週・月ごとに 1 ページずつあり、キーボードで打つ文字と手書きを同じページに書ける。
// 文字は他の画面のメモ欄と同じもの。手書きは iPad の Apple Pencil 向けだが、指やマウスでも書ける。
import { h } from '../dom.js';
import { state, emit, setCursor, setView, setNoteScope, dayNoteKey, weekNoteKey, monthNoteKey, hasInk } from '../store.js';
import { fmtDay, fmtMonth, fmtMD, weekDates, isoWeek, mondayOf, today } from '../dates.js';
import { inkBounds, strokePath } from '../model.js';
import { loadInk, cachedInk, saveInk, blankInk, onRemoteInk, PAGE_W } from '../ink.js';
import { createInkPad, tool, COLORS, COLOR_NAMES, WIDTHS } from '../inkpad.js';
import { NoteBox, icon } from '../ui.js';

const SCOPES = [
  ['day', '日'],
  ['week', '週'],
  ['month', '月'],
];

export const noteKeyFor = (scope, date) => (scope === 'month' ? monthNoteKey(date) : scope === 'week' ? weekNoteKey(date) : dayNoteKey(date));

// ---- 手書きキャンバス（画面を描き直しても同じものを使い回す） ----

let pad = null;
let shownKey = null;
let unsaved = null; // まだ保存していない手書き
let saveTimer = 0;

function save() {
  clearTimeout(saveTimer);
  if (!unsaved) return;
  const doc = unsaved;
  unsaved = null;
  saveInk({ key: doc.key, h: doc.h, strokes: doc.strokes, u: Date.now() });
}

/** 書きかけの手書きをすぐ保存する（別の画面へ移るとき・アプリを閉じるとき） */
export function flushInk() {
  save();
}

function ensurePad() {
  if (pad) return pad;
  pad = createInkPad({
    onChange: doc => {
      unsaved = doc;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 600);
    },
    onState: () => emit(), // 「元に戻す」などのボタンの状態を更新する
  });
  // 開いているページの手書きが他の端末で書き換えられたら、表示を差し替える（自分が書いている最中は除く）
  onRemoteInk(doc => {
    if (doc.key === shownKey && !unsaved && !pad.busy) pad.show(doc);
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save());
  window.addEventListener('pagehide', save);
  return pad;
}

function showPage(key) {
  if (key === shownKey) return;
  save();
  shownKey = key;
  pad.show(null);
  loadInk(key).then(doc => {
    if (shownKey === key) pad.show(doc || blankInk(key));
  });
}

// ---- 画面 ----

function pageTitle(scope, cursor) {
  const ws = state.settings.weekStart;
  if (scope === 'month') return fmtMonth(cursor);
  if (scope === 'week') {
    const days = weekDates(cursor, ws);
    return `${fmtMD(days[0])}〜${fmtMD(days[6])} の週（W${isoWeek(mondayOf(days[0], ws))}）`;
  }
  return `${fmtDay(cursor)}${cursor === today() ? '・今日' : ''}`;
}

const ToolButton = (label, on, onclick, extra = {}) =>
  h('button', { class: `nb-tool${on ? ' on' : ''}`, 'aria-pressed': String(!!on), onclick, ...extra }, label);

function Toolbar() {
  const pen = tool.mode === 'pen';
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const set = patch => {
    Object.assign(tool, patch);
    emit();
  };
  return h(
    'div',
    { class: 'nb-tools', role: 'toolbar', 'aria-label': '手書きの道具' },
    COLORS.map((color, i) =>
      h('button', {
        class: `nb-color${pen && tool.color === i ? ' on' : ''}`,
        style: { '--c': color },
        'aria-label': `${COLOR_NAMES[i]}のペン`,
        'aria-pressed': String(pen && tool.color === i),
        title: `${COLOR_NAMES[i]}のペン`,
        onclick: () => set({ mode: 'pen', color: i }),
      }),
    ),
    h('span', { class: 'nb-sep' }),
    WIDTHS.map((w, i) =>
      h(
        'button',
        {
          class: `nb-tool nb-width${tool.width === i ? ' on' : ''}`,
          'aria-label': i === 0 ? '細いペン' : '太いペン',
          'aria-pressed': String(tool.width === i),
          title: i === 0 ? '細い' : '太い',
          onclick: () => set({ width: i, mode: 'pen' }),
        },
        h('span', { style: { width: `${w * 2.2}px`, height: `${w * 2.2}px` } }),
      ),
    ),
    h('span', { class: 'nb-sep' }),
    ToolButton('消しゴム', tool.mode === 'eraser', () => set({ mode: tool.mode === 'eraser' ? 'pen' : 'eraser' }), { title: 'なぞった線を消す' }),
    h('button', { class: 'nb-tool', disabled: !pad.canUndo, onclick: () => pad.undo() }, '元に戻す'),
    h('button', { class: 'nb-tool', disabled: pad.isEmpty, title: 'このページの手書きをすべて消す（「元に戻す」で戻せます）', onclick: () => pad.clear() }, '全部消す'),
    touch
      ? ToolButton('指で書く', tool.finger, () => set({ finger: !tool.finger }), { title: 'オフのとき、指はスクロール・ペンは書く' })
      : null,
  );
}

export function NotebookView() {
  ensurePad();
  const { cursor, noteScope: scope } = state.ui;
  const key = noteKeyFor(scope, cursor);
  showPage(key);

  const text = NoteBox(key, { placeholder: 'キーボードで入力…', cls: 'nb-text', label: `${pageTitle(scope, cursor)} のメモ（文字）` });
  const fit = () => {
    text.rows = Math.min(40, Math.max(3, text.value.split('\n').length + 1));
  };
  fit();
  text.addEventListener('input', fit);

  return h(
    'div',
    { class: 'nb' },
    h(
      'div',
      { class: 'nb-bar' },
      h(
        'div',
        { class: 'segs', role: 'tablist', 'aria-label': 'ノートのページ' },
        SCOPES.map(([value, label]) =>
          h('button', { class: `seg${scope === value ? ' on' : ''}`, role: 'tab', 'aria-selected': String(scope === value), onclick: () => setNoteScope(value) }, label),
        ),
      ),
      Toolbar(),
    ),
    h(
      'div',
      { class: 'nb-scroll', dataset: { sk: `nb:${key}`, inkScroll: '1' } },
      h(
        'div',
        { class: 'nb-page' },
        h('h2', { class: 'nb-title' }, pageTitle(scope, cursor)),
        text,
        h('div', { class: 'nb-ink' }, pad.el),
        h('button', { class: 'btn small nb-extend', disabled: !pad.canExtend, onclick: () => pad.extend() }, icon('plus', 14), 'ページを下に伸ばす'),
      ),
    ),
  );
}

// ---- 他の画面から使う部品 ----

/** キーに対応するノートのページを開く */
export function openNotebook(key) {
  flushInk();
  const [kind, value] = [key[0], key.slice(2)];
  const scope = kind === 'm' ? 'month' : kind === 'w' ? 'week' : 'day';
  if (document.documentElement.dataset.mode === 'today') {
    // 今日の一覧（小さな窓）からは、Planner 全体のノート画面へ移動する
    location.assign(`./?note=${scope}`);
    return;
  }
  let date = state.ui.cursor;
  if (kind === 'd') date = value;
  else if (kind === 'm' && !date.startsWith(value)) date = `${value}-01`;
  else if (kind === 'w' && weekNoteKey(date) !== key) date = value;
  state.ui.noteScope = scope;
  setCursor(date);
  setView('note');
}

/** メモ欄の見出しに置く「ノートを開く」ボタン */
export const NotebookButton = key =>
  h('button', { class: 'btn small ghost nb-open', title: 'ノートで開く（手書きもできます）', 'aria-label': 'ノートで開く', onclick: () => openNotebook(key) }, icon('pen', 15));

/** 手書きの小さなプレビュー。手書きが無ければ何も出さない。押すとノートが開く */
export function InkPreview(key) {
  if (!hasInk(key)) return null;
  const doc = cachedInk(key);
  const bounds = doc && inkBounds(doc);
  const open = () => openNotebook(key);
  if (!bounds) return h('button', { class: 'ink-preview', onclick: open }, '手書きメモ…');
  const pad = 14;
  const x = Math.max(0, bounds[0] - pad);
  const y = Math.max(0, bounds[1] - pad);
  const w = Math.min(PAGE_W, bounds[2] + pad) - x;
  const height = bounds[3] + pad - y;
  const holder = h('button', { class: 'ink-preview', title: '手書きメモを開く', 'aria-label': '手書きメモを開く', onclick: open });
  // 数値と決まった色だけで組み立てている（手書きデータの中身を HTML として解釈させない）
  const paths = doc.strokes
    .map(s => `<path d="${strokePath(s)}" stroke="${COLORS[s.c] || COLORS[0]}" stroke-width="${(Number(s.w) || WIDTHS[0]) * 1.15}"/>`)
    .join('');
  holder.innerHTML = `<svg viewBox="${x} ${y} ${w} ${height}" preserveAspectRatio="xMinYMin meet" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  return holder;
}
