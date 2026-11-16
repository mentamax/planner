// 今日の一覧。小さな窓に置いておく用の画面（today.html）で、今日の予定・タスク・メモと明日の予定をまとめて見せる。
import { h } from '../dom.js';
import { eventsOn, tasksOn, dayNoteKey, overdueTasks } from '../store.js';
import { today, addDays, fmtDay } from '../dates.js';
import { daySegments } from '../model.js';
import { NoteBox, TaskRow, EventRow, QuickAdd } from '../ui.js';
import { ProgressBar } from './board.js';

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

export function TodayView() {
  const t = today();
  const tomorrow = addDays(t, 1);
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const events = eventsOn(t);
  const tasks = tasksOn(t);
  const done = tasks.filter(i => i.done).length;
  const overdue = overdueTasks();
  const next = [...eventsOn(tomorrow).map(i => EventRow(i, tomorrow)), ...tasksOn(tomorrow).map(i => TaskRow(i, { date: tomorrow }))];

  return h(
    'div',
    { class: 'today' },
    Section('予定', Meta(events.length ? `${events.length} 件` : ''), events.length ? events.map(i => TimedEventRow(i, t, nowMin)) : Empty('今日の予定はありません')),
    Section(
      'タスク',
      Meta(tasks.length ? `${done} / ${tasks.length} 完了` : '', tasks.length && done === tasks.length ? 'all' : ''),
      tasks.length ? ProgressBar({ done, total: tasks.length }) : null,
      tasks.map(i => TaskRow(i, { date: t })),
      QuickAdd({ date: t, fk: `qa:today:${t}`, placeholder: '＋ 今日のタスクを追加' }),
    ),
    overdue.length
      ? Section(
          '期限切れ',
          Meta(`${overdue.length} 件`, 'late'),
          overdue.slice(0, 15).map(i => TaskRow(i, { showDate: true })),
          overdue.length > 15 ? Empty(`ほか ${overdue.length - 15} 件`) : null,
        )
      : null,
    Section('メモ', null, NoteBox(dayNoteKey(t), { placeholder: '今日のメモ…', cls: 'today-note', label: `${fmtDay(t)} のメモ` })),
    Section(`明日　${fmtDay(tomorrow)}`, Meta(next.length ? `${next.length} 件` : ''), next.length ? next : Empty('予定・タスクはありません')),
  );
}
