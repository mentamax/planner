// 今日の一覧。小さな窓に置いておく用の画面（today.html）で、今日の予定・タスク・メモと明日の予定をまとめて見せる。
import { h } from '../dom.js';
import { eventsOn, tasksOn, dayNoteKey, overdueTasks } from '../store.js';
import { today, addDays, fmtDay } from '../dates.js';
import { daySegments } from '../model.js';
import { NoteBox, TaskRow, EventRow, QuickAdd } from '../ui.js';
import { ProgressBar } from './board.js';
import { InkPreview, NotebookButton } from './notebook.js';

const Section = (title, meta, ...content) =>
  h(
    'section',
    { class: 'today-sec' },
    h('header', { class: 'today-head' }, h('h2', null, title), meta),
    content,
  );

const Meta = (text, cls = '') => (text ? h('span', { class: `today-meta ${cls}` }, text) : null);
const Empty = text => h('p', { class: 'empty' }, text);

/** 予定の行に「いま進行中」「もう終わった」の印を付ける */
function TimedEventRow(item, date, nowMin) {
  const row = EventRow(item, date);
  const seg = daySegments([item], date)[0];
  if (seg && nowMin >= seg.e) row.classList.add('past');
  else if (seg && nowMin >= seg.s) row.classList.add('now');
  return row;
}

/** date を省くと今日。Planner 本体の「今日」タブでは、前後の日にも移動できる */
export function TodayView(date) {
  const t = today();
  const d = date || t;
  const isToday = d === t;
  const next = addDays(d, 1);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const events = eventsOn(d);
  const tasks = tasksOn(d);
  const done = tasks.filter(i => i.done).length;
  const overdue = isToday ? overdueTasks() : [];
  const nextItems = [...eventsOn(next).map(i => EventRow(i, next)), ...tasksOn(next).map(i => TaskRow(i, { date: next }))];
  const memoKey = dayNoteKey(d);

  return h(
    'div',
    { class: 'today' },
    Section(
      '予定',
      Meta(events.length ? `${events.length} 件` : ''),
      events.length ? events.map(i => (isToday ? TimedEventRow(i, d, nowMin) : EventRow(i, d))) : Empty(isToday ? '今日の予定はありません' : '予定はありません'),
    ),
    Section(
      'タスク',
      Meta(tasks.length ? `${done} / ${tasks.length} 完了` : '', tasks.length && done === tasks.length ? 'all' : ''),
      tasks.length ? ProgressBar({ done, total: tasks.length }) : null,
      tasks.map(i => TaskRow(i, { date: d })),
      QuickAdd({ date: d, fk: `qa:today:${d}`, placeholder: isToday ? '＋ 今日のタスクを追加' : '＋ タスクを追加' }),
    ),
    overdue.length
      ? Section(
          '期限切れ',
          Meta(`${overdue.length} 件`, 'late'),
          overdue.slice(0, 15).map(i => TaskRow(i, { showDate: true })),
          overdue.length > 15 ? Empty(`ほか ${overdue.length - 15} 件`) : null,
        )
      : null,
    Section(
      'メモ',
      NotebookButton(memoKey),
      NoteBox(memoKey, { placeholder: isToday ? '今日のメモ…' : 'この日のメモ…', cls: 'today-note', label: `${fmtDay(d)} のメモ` }),
      InkPreview(memoKey),
    ),
    Section(`${isToday ? '明日' : '翌日'}　${fmtDay(next)}`, Meta(nextItems.length ? `${nextItems.length} 件` : ''), nextItems.length ? nextItems : Empty('予定・タスクはありません')),
  );
}
