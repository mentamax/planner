// 週表示。上から「日付」「終日の予定とタスク」「時間軸」「日ごとのメモ」。
import { h } from '../dom.js';
import { state, itemsOn, tasksOn, dayNoteKey } from '../store.js';
import { weekDates, today, WD, dow, isoWeek, mondayOf, minToTime, addDays, fmtDay, pad } from '../dates.js';
import { daySegments, layoutSegments } from '../model.js';
import { NoteBox, dragSource, dropTarget, timeLabel } from '../ui.js';
import { Chip } from './month.js';
import { openItemDialog } from '../dialogs.js';

export const HOUR = 46; // 1 時間の高さ(px)。style.css の --hour と合わせる

export function WeekView() {
  const ws = state.settings.weekStart;
  const days = weekDates(state.ui.cursor, ws);
  const t = today();
  const dayCls = d => `wd-${dow(d)}${d === t ? ' today' : ''}`;

  const head = h(
    'div',
    { class: 'wk-sticky' },
    h(
      'div',
      { class: 'wk-row wk-head' },
      h('div', { class: 'wk-gutter' }, `W${isoWeek(mondayOf(days[0], ws))}`),
      days.map(d => {
        const tasks = tasksOn(d);
        const done = tasks.filter(i => i.done).length;
        return h(
          'div',
          { class: `wk-dayhead ${dayCls(d)}${d === state.ui.cursor ? ' cursor' : ''}` },
          h('span', { class: 'wk-wd' }, WD[dow(d)]),
          h('span', { class: 'wk-num' }, Number(d.slice(8))),
          tasks.length ? h('span', { class: `wk-count${done === tasks.length ? ' all' : ''}`, title: 'タスクの完了数' }, `${done}/${tasks.length}`) : null,
        );
      }),
    ),
    h(
      'div',
      { class: 'wk-row wk-allday' },
      h('div', { class: 'wk-gutter' }, '終日', h('br'), 'タスク'),
      days.map(d =>
        h(
          'div',
          {
            class: `wk-alldaycell ${dayCls(d)}`,
            title: 'ダブルクリックで追加',
            ondblclick: () => openItemDialog({ defaults: { date: d } }),
            ...dropTarget(d),
          },
          itemsOn(d).filter(i => !i.startTime).map(i => Chip(i, d)),
          h('button', { class: 'wk-add', 'aria-label': `${fmtDay(d)} に追加`, onclick: () => openItemDialog({ defaults: { date: d } }) }, '+'),
        ),
      ),
    ),
  );

  const grid = h(
    'div',
    { class: 'wk-row wk-grid' },
    h(
      'div',
      { class: 'wk-gutter wk-hours' },
      Array.from({ length: 23 }, (_, i) => h('span', { style: { top: `${(i + 1) * HOUR}px` } }, `${pad(i + 1)}:00`)),
    ),
    days.map(d => DayColumn(d, d === t)),
  );

  const notes = h(
    'div',
    { class: 'wk-row wk-notes' },
    h('div', { class: 'wk-gutter' }, 'メモ'),
    days.map(d => h('div', { class: `wk-notecell ${dayCls(d)}` }, NoteBox(dayNoteKey(d), { placeholder: 'メモ', label: `${fmtDay(d)} のメモ` }))),
  );

  return h(
    'div',
    {
      class: 'week',
      // 縦は 7:00 から。横（スマホで 3 日分ずつ見るとき）は選択中の日から
      dataset: { sk: 'week', skInit: String(7 * HOUR - 6), skKey: state.ui.cursor, skInitLeft: '.wk-dayhead.cursor', skInitOffset: '40' },
    },
    head,
    grid,
    notes,
  );
}

function DayColumn(d, isToday) {
  const segs = layoutSegments(daySegments(itemsOn(d), d));
  const now = new Date();

  return h(
    'div',
    {
      class: `wk-col wd-${dow(d)}${isToday ? ' today' : ''}`,
      title: 'クリックで予定を追加',
      onclick: e => {
        if (e.target !== e.currentTarget) return;
        const y = e.clientY - e.currentTarget.getBoundingClientRect().top;
        const start = Math.max(0, Math.min(Math.floor((y / HOUR) * 2) * 30, 1410));
        const end = start + 60;
        openItemDialog({
          defaults: {
            kind: 'event',
            date: d,
            startTime: minToTime(start),
            endTime: minToTime(end % 1440),
            endDate: end >= 1440 ? addDays(d, 1) : d,
          },
        });
      },
      ...dropTarget(d),
    },
    segs.map(seg => {
      const height = Math.max(((seg.e - seg.s) / 60) * HOUR, 22) - 2;
      const { item } = seg;
      return h(
        'div',
        {
          class: `wk-event${height < 36 ? ' short' : ''}`,
          title: `${item.title}（${timeLabel(item, d)}）`,
          style: {
            '--c': item.color || 'var(--accent)',
            top: `${(seg.s / 60) * HOUR}px`,
            height: `${height}px`,
            left: `calc(${(seg.col / seg.cols) * 100}% + 1px)`,
            width: `calc(${100 / seg.cols}% - 3px)`,
          },
          ...dragSource(item, d),
          onclick: e => {
            e.stopPropagation();
            openItemDialog({ item });
          },
        },
        h('span', { class: 'wk-event-title' }, item.title),
        h('span', { class: 'wk-event-time' }, timeLabel(item, d)),
      );
    }),
    isToday ? h('div', { class: 'wk-now', style: { top: `${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR}px` } }) : null,
  );
}
