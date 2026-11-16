// 各ビューで共通して使う部品。
import { h } from './dom.js';
import { state, setNote, hasNote, toggleDone, createItem, updateItem, findItem } from './store.js';
import { shiftDates } from './model.js';
import { fmtMD, today } from './dates.js';
import { openItemDialog } from './dialogs.js';

const ICONS = {
  left: '<path d="M15 6l-6 6 6 6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="M4 7h8M18 7h2M4 17h2M12 17h8"/><circle cx="15" cy="7" r="2.5"/><circle cx="9" cy="17" r="2.5"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.3 4.3L20 15.5M20 20v-4.5h-4.5"/>',
  note: '<path d="M6 4h12v16H6zM9 9h6M9 13h6M9 17h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  link: '<path d="M14 5h5v5M19 5l-8 8M11 7H6v11h11v-5"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-7.96A6 6 0 0 1 18 9.5a4.25 4.25 0 0 1-.5 8.5z"/>',
  calendar: '<path d="M5 6h14v14H5zM5 10h14M9 4v4M15 4v4"/>',
};

/** スマホ幅か（style.css の 640px と合わせる） */
export const isPhone = () => window.matchMedia('(max-width: 640px)').matches;

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span;
}

// ---- メモ欄 ----

/** 入力するとすぐ保存されるメモ欄。key は日のメモ（d:日付）か週のメモ（w:月曜の日付） */
export function NoteBox(key, { placeholder = 'メモ', cls = '', label } = {}) {
  return h('textarea', {
    class: `note ${cls}`,
    placeholder,
    'aria-label': label || placeholder,
    spellcheck: false,
    value: state.notes[key] || '',
    dataset: { fk: `note:${key}` },
    oninput: e => {
      setNote(key, e.target.value);
      // 月表示などの「メモあり」印だけをその場で更新する（入力欄は描き直さない）
      document.querySelectorAll('[data-notedot]').forEach(dot => {
        if (dot.dataset.notedot === key) dot.classList.toggle('has', hasNote(key));
      });
    },
  });
}

export const NoteDot = (key, title = 'メモあり') =>
  h('span', { class: `notedot${hasNote(key) ? ' has' : ''}`, title, dataset: { notedot: key } });

// ---- チェックボックス・行 ----

export function Check(item) {
  return h('button', {
    class: `check${item.done ? ' on' : ''}`,
    role: 'checkbox',
    'aria-checked': String(item.done),
    'aria-label': `${item.title} を${item.done ? '未完了に戻す' : '完了にする'}`,
    onclick: e => {
      e.stopPropagation();
      toggleDone(item.id);
    },
  });
}

export const timeLabel = (item, date) => {
  if (!item.startTime) return '終日';
  const end = item.endDate || item.date;
  if (date && date !== item.date) return date === end ? `〜${item.endTime}` : '終日';
  return `${item.startTime}–${item.endTime}`;
};

export function TaskRow(item, { showDate = false, date = item.date } = {}) {
  return h(
    'div',
    {
      class: `row task-row${item.done ? ' done' : ''}`,
      ...dragSource(item, date),
      onclick: () => openItemDialog({ item }),
    },
    Check(item),
    h('span', { class: 'row-title' }, item.title),
    showDate && item.date ? h('span', { class: `row-date${!item.done && item.date < today() ? ' late' : ''}` }, fmtMD(item.date)) : null,
    PendingMark(item),
  );
}

export function EventRow(item, date) {
  return h(
    'div',
    {
      class: 'row event-row',
      style: { '--c': item.color || 'var(--accent)' },
      ...dragSource(item, date),
      onclick: () => openItemDialog({ item }),
    },
    h('span', { class: 'row-bar' }),
    h('span', { class: 'row-main' }, h('span', { class: 'row-time' }, timeLabel(item, date)), h('span', { class: 'row-title' }, item.title)),
    PendingMark(item),
  );
}

/** Google に接続済みなのにまだ送れていない変更の印 */
export const PendingMark = item =>
  item.sync !== 'synced' && state.auth.status !== 'disconnected'
    ? h('span', { class: 'pending-mark', title: 'Google に未反映' })
    : null;

/** Enter でタスクを追加する 1 行入力 */
export function QuickAdd({ date = null, fk, placeholder = '＋ タスクを追加' }) {
  return h('input', {
    class: 'quickadd',
    type: 'text',
    placeholder,
    'aria-label': date ? `${fmtMD(date)} にタスクを追加` : 'タスクを追加',
    dataset: { fk, keep: '1' },
    onkeydown: e => {
      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
      const title = e.target.value.trim();
      if (!title) return;
      e.target.value = '';
      createItem({ kind: 'task', title, date });
    },
  });
}

// ---- ドラッグ＆ドロップ（日付の移動） ----

const MIME = 'application/x-planner-item';

export function dragSource(item, date) {
  if (item.readOnly) return {};
  return {
    draggable: true,
    ondragstart: e => {
      e.stopPropagation();
      e.dataTransfer.setData(MIME, JSON.stringify({ id: item.id, from: date || null }));
      e.dataTransfer.effectAllowed = 'move';
    },
  };
}

/** date が null のときは「日付なし」への移動（タスクのみ） */
export function dropTarget(date) {
  const accepts = e => e.dataTransfer?.types.includes(MIME);
  return {
    ondragover: e => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      e.currentTarget.classList.add('drop-over');
    },
    ondragleave: e => {
      if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('drop-over');
    },
    ondrop: e => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.currentTarget.classList.remove('drop-over');
      let data;
      try {
        data = JSON.parse(e.dataTransfer.getData(MIME));
      } catch {
        return;
      }
      const item = findItem(data.id);
      if (!item || item.readOnly) return;
      if (date === null) {
        if (item.kind === 'task' && item.date) updateItem(item.id, { date: null });
        return;
      }
      if ((data.from || item.date) === date) return;
      updateItem(item.id, shiftDates(item, data.from, date));
    },
  };
}

// ---- トースト（元に戻す など） ----

let toastTimer = 0;
export function toast(message, { action, onAction, ms = 6000 } = {}) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', null, message),
    action
      ? h('button', {
          class: 'toast-action',
          onclick: () => {
            el.remove();
            onAction?.();
          },
        }, action)
      : null,
  );
  document.getElementById('overlays').append(el);
  toastTimer = setTimeout(() => el.remove(), ms);
}
