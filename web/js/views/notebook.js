// ノート。日・週・月ごとに 1 ページずつあり、キーボードで打つ文字と手書きを同じページに書ける。
// 文字は他の画面のメモ欄と同じもの。手書きは iPad の Apple Pencil 向けだが、指やマウスでも書ける。
import { h } from '../dom.js';
import { state, emit, setCursor, setView, setNoteScope, dayNoteKey, weekNoteKey, monthNoteKey, hasInk } from '../store.js';
import { fmtDay, fmtMonth, fmtMD, weekDates, isoWeek, mondayOf, today } from '../dates.js';
import { inkBounds, strokePath } from '../model.js';
import { loadInk, cachedInk, saveInk, blankInk, onRemoteInk, PAGE_W } from '../ink.js';
import { createInkPad, tool, pen, COLORS, COLOR_NAMES, WIDTHS } from '../inkpad.js';
import { NoteBox, icon, toast } from '../ui.js';

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
    // 書くたびに画面全体を作り直すと書き心地が悪くなるので、ボタンの有効・無効だけをその場で直す
    onState: syncButtons,
    onPen: () => emit(), // 初めてペンを検知したら、スクロール方法の案内を出す
  });
  // 開いているページの手書きが他の端末で書き換えられたら、表示を差し替える（自分が書いている最中は除く）
  onRemoteInk(doc => {
    if (doc.key === shownKey && !unsaved && !pad.busy) pad.show(doc);
  });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && save());
  window.addEventListener('pagehide', save);
  return pad;
}

function syncButtons() {
  const set = (name, disabled) => {
    const button = document.querySelector(`[data-nb="${name}"]`);
    if (button) button.disabled = disabled;
  };
  set('undo', !pad.canUndo);
  set('clear', pad.isEmpty);
  set('extend', !pad.canExtend);
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
  const touch = window.matchMedia('(any-pointer: coarse)').matches;
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
    h('button', { class: 'nb-tool', disabled: !pad.canUndo, dataset: { nb: 'undo' }, onclick: () => pad.undo() }, '元に戻す'),
    h('button', { class: 'nb-tool', disabled: pad.isEmpty, dataset: { nb: 'clear' }, title: 'このページの手書きをすべて消す（「元に戻す」で戻せます）', onclick: () => pad.clear() }, '全部消す'),
    touch ? ToolButton('指で書く', tool.finger, () => set({ finger: !tool.finger }), { title: 'オフのとき、書けるのはペンだけ' }) : null,
    // ペンを使っている端末では、指 1 本には反応しない（手が触れても動かないようにするため）
    touch && pen.seen && !tool.finger ? h('span', { class: 'nb-hint' }, 'スクロールは 2 本指か、右端の帯で') : null,
    ToolButton('診断', diagOn, () => {
      diagOn = !diagOn;
      emit();
    }, { title: '手書きの入力状態を表示する（書き心地に問題があるときの原因調べ用）' }),
  );
}

// ノートの画面は 1 度だけ組み立てて使い回す。同期の完了などで画面全体が描き直されても、
// キャンバスやスクロール位置に触れない（書いている最中の引っかかりや、書きかけの線の消失を防ぐ）。
let view = null; // { root, bar, diag, scroll, title, textHost, extend, key }
let diagOn = false;
let diagTimer = 0;

function build() {
  const bar = h('div', { class: 'nb-bar' });
  const diagText = h('pre', { class: 'nb-diagtext' });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(diagText.textContent);
      toast('診断の内容をコピーしました。チャットに貼り付けてください');
    } catch {
      toast('コピーできませんでした。スクリーンショットで送ってください');
    }
  };
  const diag = h('div', { class: 'nb-diag', hidden: true }, diagText, h('button', { class: 'btn small', onclick: copy }, '診断をコピー'));
  const title = h('h2', { class: 'nb-title' });
  const textHost = h('div', { class: 'nb-texthost' });
  const extend = h('button', { class: 'btn small nb-extend', dataset: { nb: 'extend' }, onclick: () => pad.extend() }, icon('plus', 14), 'ページを下に伸ばす');
  // 右端の帯は、指でなぞるとページをスクロールできる場所（タッチ操作の端末でだけ表示）
  const ink = h('div', { class: 'nb-ink' }, pad.el, h('div', { class: 'nb-strip', 'aria-hidden': 'true' }));
  const scroll = h('div', { class: 'nb-scroll', dataset: { inkScroll: '1' } }, h('div', { class: 'nb-page' }, title, textHost, ink, extend));
  view = { root: h('div', { class: 'nb' }, bar, diag, scroll), bar, diag, diagText, scroll, title, textHost, extend, key: null };
}

function showDiagnostics() {
  clearInterval(diagTimer);
  view.diag.hidden = !diagOn;
  if (!diagOn) return;
  const yes = v => (v ? '対応' : '非対応');
  const update = () => {
    if (!view.diag.isConnected) return;
    const d = pad.diagnostics();
    const line = (l, i) =>
      `線${i + 1}: 種類=${l.type} 長さ=${l.ms}ms 通知=${l.movesPerSec}回/秒 位置=${l.samplesPerSec}点/秒（1通知あたり${l.perMove}点） 記録=${l.points}点 遅れ=${l.lagMs}ms 筆圧=${l.pressure[0]}〜${l.pressure[1]} 先読み=${l.predicted ? 'あり' : 'なし'}`;
    view.diagText.textContent = [
      `細かい動きの取得: ${yes(d.coalesced)} / 先読み: ${yes(d.predicted)} / ペンの使用: ${d.penSeen ? 'あり' : 'まだなし'}`,
      `キャンバス: ${d.canvas} / ページ上の線の数: ${d.strokes}`,
      d.recent.length ? d.recent.map(line).join('\n') : 'ここを開いたあとに書いた線: まだありません（ペンで 2〜3 本書くと、新しい順に表示されます）',
    ].join('\n');
  };
  update();
  diagTimer = setInterval(update, 500);
}

export function NotebookView() {
  ensurePad();
  if (!view) build();
  const { cursor, noteScope: scope } = state.ui;
  const key = noteKeyFor(scope, cursor);
  showPage(key);

  // ツールバーは小さいので毎回作り直す（選んでいる道具やページの切り替えを反映する）
  view.bar.replaceChildren(
    h(
      'div',
      { class: 'segs', role: 'tablist', 'aria-label': 'ノートのページ' },
      SCOPES.map(([value, label]) =>
        h('button', { class: `seg${scope === value ? ' on' : ''}`, role: 'tab', 'aria-selected': String(scope === value), onclick: () => setNoteScope(value) }, label),
      ),
    ),
    Toolbar(),
  );
  view.extend.disabled = !pad.canExtend;

  const current = view.textHost.firstChild;
  if (view.key !== key) {
    // 別のページに切り替わった
    view.key = key;
    view.title.textContent = pageTitle(scope, cursor);
    const text = NoteBox(key, { placeholder: 'キーボードで入力…', cls: 'nb-text', label: `${pageTitle(scope, cursor)} のメモ（文字）` });
    const fit = () => {
      text.rows = Math.min(40, Math.max(3, text.value.split('\n').length + 1));
    };
    fit();
    text.addEventListener('input', fit);
    view.textHost.replaceChildren(text);
    view.scroll.scrollTop = 0;
  } else if (current && document.activeElement !== current && current.value !== (state.notes[key] || '')) {
    // 他の端末で書き換えられた文字を反映する（自分が入力している最中は触らない）
    current.value = state.notes[key] || '';
  }
  showDiagnostics();
  return view.root;
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
