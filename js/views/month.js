// 月表示。週ごとの行の左端に週番号（週メモの印つき）、各日に予定とタスクを並べる。
import { h } from '../dom.js';
import { state, emit, itemsOn, setCursor, setView, dayNoteKey, weekNoteKey, toggleDone } from '../store.js';
import { monthWeeks, today, WD, dow, isoWeek, mondayOf, fmtDay } from '../dates.js';
import { NoteDot, dragSource, dropTarget, isPhone } from '../ui.js';
import { openItemDialog } from '../dialogs.js';

export function MonthView() {
  const { cursor } = state.ui;
  const ws = state.settings.weekStart;
  const weeks = monthWeeks(cursor, ws);
  const month = cursor.slice(0, 7);
  const t = today();

  // 1 マスに収まる件数を、表示領域の実際の高さから決める
  const measure = () => document.querySelector('.main')?.clientHeight || 0;
  const mainHeight = measure() || window.innerHeight - 56;
  const cellHeight = (mainHeight - 30) / weeks.length;
  // スマホでは予定を小さな点で表す（タップすると下に一覧が出る）ので、数だけ決める
  const maxChips = isPhone() ? 7 : Math.max(1, Math.floor((cellHeight - 28) / 22));
  // 描画後に高さが変わっていたら（初回表示や、右パネルが下に回り込んだとき）描き直す
  setTimeout(() => {
    const now = measure();
    if (now && Math.abs(now - mainHeight) > 12 && state.ui.view === 'month') emit();
  }, 0);

  return h(
    'div',
    { class: 'month', style: { '--rows': weeks.length } },
    h(
      'div',
      { class: 'month-head' },
      h('div', { class: 'month-wk' }),
      weeks[0].map(d => h('div', { class: `month-wd wd-${dow(d)}` }, WD[dow(d)])),
    ),
    weeks.map(week =>
      h(
        'div',
        { class: 'month-row' },
        h(
          'button',
          {
            class: 'month-wk',
            title: `第${isoWeek(mondayOf(week[0], ws))}週を週表示で開く`,
            onclick: () => {
              setCursor(week.includes(cursor) ? cursor : week[0]);
              setView('week');
            },
          },
          h('span', null, `W${isoWeek(mondayOf(week[0], ws))}`),
          NoteDot(weekNoteKey(week[0]), '週のメモあり'),
        ),
        week.map(d => DayCell(d, { month, t, cursor, maxChips })),
      ),
    ),
  );
}

function DayCell(d, { month, t, cursor, maxChips }) {
  const items = itemsOn(d);
  const overflow = items.length > maxChips;
  const shown = overflow ? items.slice(0, maxChips - 1) : items;
  const dayNum = Number(d.slice(8));
  const cls = ['day', `wd-${dow(d)}`, d.slice(0, 7) !== month && 'other', d === t && 'today', d === cursor && 'selected'].filter(Boolean).join(' ');

  return h(
    'div',
    {
      class: cls,
      role: 'button',
      tabIndex: 0,
      'aria-label': `${fmtDay(d)} ${items.length}件`,
      onclick: () => setCursor(d),
      ondblclick: () => openItemDialog({ defaults: { date: d } }),
      onkeydown: e => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') openItemDialog({ defaults: { date: d } });
        if (e.key === ' ') {
          e.preventDefault();
          setCursor(d);
        }
      },
      ...dropTarget(d),
    },
    h(
      'div',
      { class: 'day-top' },
      h('span', { class: 'day-num' }, dayNum === 1 ? `${Number(d.slice(5, 7))}/1` : dayNum),
      NoteDot(dayNoteKey(d)),
      h('button', {
        class: 'day-add',
        title: 'この日に追加',
        'aria-label': `${fmtDay(d)} に追加`,
        onclick: e => {
          e.stopPropagation();
          openItemDialog({ defaults: { date: d } });
        },
      }, '+'),
    ),
    h(
      'div',
      { class: 'chips' },
      shown.map(i => Chip(i, d)),
      overflow
        ? h('div', { class: 'chip-more' }, isPhone() ? `+${items.length - shown.length}` : shown.length ? `ほか ${items.length - shown.length} 件` : `${items.length} 件`)
        : null,
    ),
  );
}

/** 月・週の「終日/タスク」欄で使う 1 行の小さなラベル */
export function Chip(item, date) {
  const isTask = item.kind === 'task';
  const timed = !isTask && item.startTime;
  const cls = ['chip', isTask ? 'chip-task' : timed ? 'chip-timed' : 'chip-allday', item.done && 'done'].filter(Boolean).join(' ');
  return h(
    'div',
    {
      class: cls,
      style: { '--c': item.color || 'var(--accent)' },
      title: item.title,
      ...dragSource(item, date),
      onclick: e => {
        e.stopPropagation();
        openItemDialog({ item });
      },
      ondblclick: e => e.stopPropagation(),
    },
    isTask
      ? h('span', {
          class: `chip-check${item.done ? ' on' : ''}`,
          role: 'checkbox',
          'aria-checked': String(item.done),
          'aria-label': `${item.title} を${item.done ? '未完了に戻す' : '完了にする'}`,
          onclick: e => {
            e.stopPropagation();
            toggleDone(item.id);
          },
        })
      : timed
        ? h('span', { class: 'chip-dot' })
        : null,
    timed && date === item.date ? h('span', { class: 'chip-time' }, item.startTime) : null,
    h('span', { class: 'chip-title' }, item.title),
  );
}
