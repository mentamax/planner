// 右側のパネル。選択中の日の詳細（月表示のみ）、週のメモ、期限切れ・日付なしのタスク。
import { h } from '../dom.js';
import { state, eventsOn, tasksOn, dayNoteKey, weekNoteKey, monthNoteKey, overdueTasks, undatedTasks } from '../store.js';
import { weekDates, fmtDay, fmtMD, fmtMonth, isoWeek, mondayOf, today } from '../dates.js';
import { InkPreview, NotebookButton } from './notebook.js';
import { NoteBox, TaskRow, EventRow, QuickAdd, dropTarget, icon } from '../ui.js';
import { weekProgress, ProgressBar } from './board.js';
import { openItemDialog } from '../dialogs.js';

export function SidePanel() {
  const { view, cursor } = state.ui;
  const ws = state.settings.weekStart;
  const days = weekDates(cursor, ws);
  return h(
    'aside',
    { class: 'side', dataset: { sk: 'side' } },
    view === 'month' ? DaySection(cursor) : null,
    WeekSection(days, ws, view !== 'month'),
    view === 'month' ? MonthSection(cursor) : null,
    OverdueSection(),
    UndatedSection(),
  );
}

function DaySection(d) {
  const events = eventsOn(d);
  const tasks = tasksOn(d);
  return h(
    'section',
    { class: 'side-sec' },
    h(
      'header',
      { class: 'side-head' },
      h('h2', null, fmtDay(d), d === today() ? h('span', { class: 'badge' }, '今日') : null),
      h('button', { class: 'btn small', onclick: () => openItemDialog({ defaults: { date: d } }) }, icon('plus', 14), '追加'),
    ),
    events.length || tasks.length ? null : h('p', { class: 'empty' }, '予定・タスクはありません'),
    events.map(i => EventRow(i, d)),
    tasks.map(i => TaskRow(i, { date: d })),
    QuickAdd({ date: d, fk: `qa:side:${d}` }),
    h('h3', { class: 'side-sub' }, icon('note', 14), h('span', { class: 'grow' }, 'この日のメモ'), NotebookButton(dayNoteKey(d))),
    NoteBox(dayNoteKey(d), { placeholder: 'この日のメモを書く…', cls: 'side-note', label: `${fmtDay(d)} のメモ` }),
    InkPreview(dayNoteKey(d)),
  );
}

function WeekSection(days, ws, large) {
  const prog = weekProgress(days);
  return h(
    'section',
    { class: 'side-sec' },
    h(
      'header',
      { class: 'side-head' },
      h('h2', null, icon('note', 16), '週のメモ'),
      h('span', { class: 'side-meta' }, `${fmtMD(days[0])}〜${fmtMD(days[6])}・W${isoWeek(mondayOf(days[0], ws))}`),
      NotebookButton(weekNoteKey(days[0])),
    ),
    NoteBox(weekNoteKey(days[0]), {
      placeholder: '今週の目標・ふりかえりなど…',
      cls: `side-note${large ? ' large' : ''}`,
      label: '週のメモ',
    }),
    InkPreview(weekNoteKey(days[0])),
    prog.total
      ? h('div', { class: 'side-progress' }, h('span', null, `今週のタスク ${prog.done} / ${prog.total}`), ProgressBar(prog))
      : null,
  );
}

function MonthSection(d) {
  const key = monthNoteKey(d);
  return h(
    'section',
    { class: 'side-sec' },
    h('header', { class: 'side-head' }, h('h2', null, icon('note', 16), '月のメモ'), h('span', { class: 'side-meta' }, fmtMonth(d)), NotebookButton(key)),
    NoteBox(key, { placeholder: '今月の目標・予定のメモなど…', cls: 'side-note', label: '月のメモ' }),
    InkPreview(key),
  );
}

function OverdueSection() {
  const tasks = overdueTasks();
  if (!tasks.length) return null;
  return h(
    'section',
    { class: 'side-sec' },
    h('header', { class: 'side-head' }, h('h2', null, '期限切れ'), h('span', { class: 'side-meta late' }, `${tasks.length} 件`)),
    tasks.slice(0, 30).map(i => TaskRow(i, { showDate: true })),
    tasks.length > 30 ? h('p', { class: 'empty' }, `ほか ${tasks.length - 30} 件`) : null,
  );
}

function UndatedSection() {
  const tasks = undatedTasks();
  return h(
    'section',
    { class: 'side-sec side-undated', ...dropTarget(null) },
    h('header', { class: 'side-head' }, h('h2', null, '日付なしのタスク'), tasks.length ? h('span', { class: 'side-meta' }, `${tasks.filter(i => !i.done).length} 件`) : null),
    tasks.map(i => TaskRow(i)),
    QuickAdd({ date: null, fk: 'qa:undated', placeholder: '＋ いつかやることを追加' }),
  );
}
