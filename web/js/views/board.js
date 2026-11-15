// タスク表示。1 週間を日ごとの列に並べ、その日のタスク・予定・メモをまとめて見る。
import { h } from '../dom.js';
import { state, tasksOn, eventsOn, dayNoteKey, updateSettings } from '../store.js';
import { weekDates, today, WD, dow, fmtDay } from '../dates.js';
import { NoteBox, TaskRow, EventRow, QuickAdd, dropTarget } from '../ui.js';

export function weekProgress(days) {
  const tasks = days.flatMap(d => tasksOn(d));
  return { total: tasks.length, done: tasks.filter(i => i.done).length };
}

export const ProgressBar = ({ done, total }) =>
  h(
    'div',
    { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(done) },
    h('div', { class: 'progress-fill', style: { width: total ? `${(done / total) * 100}%` : '0%' } }),
  );

export function BoardView() {
  const days = weekDates(state.ui.cursor, state.settings.weekStart);
  const t = today();
  const showEvents = state.settings.showEventsOnBoard;
  const prog = weekProgress(days);

  return h(
    'div',
    { class: 'board' },
    h(
      'div',
      { class: 'board-summary' },
      h('strong', null, '今週のタスク'),
      h('span', { class: 'board-count' }, prog.total ? `${prog.done} / ${prog.total} 完了` : 'まだありません'),
      ProgressBar(prog),
      h(
        'label',
        { class: 'toggle' },
        h('input', { type: 'checkbox', checked: showEvents, onchange: e => updateSettings({ showEventsOnBoard: e.target.checked }) }),
        '予定も表示',
      ),
    ),
    h('div', { class: 'board-cols', dataset: { sk: 'board' } }, days.map(d => DayColumn(d, t, showEvents))),
  );
}

function DayColumn(d, t, showEvents) {
  const tasks = tasksOn(d);
  const events = showEvents ? eventsOn(d) : [];
  const done = tasks.filter(i => i.done).length;
  const cls = ['board-col', `wd-${dow(d)}`, d === t && 'today', d < t && 'past'].filter(Boolean).join(' ');

  return h(
    'section',
    { class: cls, 'aria-label': fmtDay(d), ...dropTarget(d) },
    h(
      'header',
      { class: 'board-colhead' },
      h('span', { class: 'board-wd' }, WD[dow(d)]),
      h('span', { class: 'board-num' }, Number(d.slice(8))),
      d === t ? h('span', { class: 'badge' }, '今日') : null,
      tasks.length ? h('span', { class: `board-colcount${done === tasks.length ? ' all' : ''}` }, `${done}/${tasks.length}`) : null,
    ),
    ProgressBar({ done, total: tasks.length }),
    h(
      'div',
      { class: 'board-list', dataset: { sk: `board:${d}` } },
      events.length ? h('div', { class: 'board-events' }, events.map(i => EventRow(i, d))) : null,
      tasks.map(i => TaskRow(i, { date: d })),
      QuickAdd({ date: d, fk: `qa:${d}` }),
    ),
    NoteBox(dayNoteKey(d), { placeholder: 'この日のメモ', cls: 'board-note', label: `${fmtDay(d)} のメモ` }),
  );
}
