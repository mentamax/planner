// アプリの外枠（ヘッダー・ビューの切り替え）と起動処理。
import { h, mount } from './dom.js';
import { state, subscribe, setView, setCursor, pendingCount } from './store.js';
import { initSync, connect, syncNow, ensureWindow } from './sync.js';
import { today, addDays, addMonths, startOfWeek, fmtMonth, fmtWeekRange, fmtDay, toHM } from './dates.js';
import { icon, isPhone } from './ui.js';
import { MonthView } from './views/month.js';
import { WeekView } from './views/week.js';
import { BoardView } from './views/board.js';
import { SidePanel } from './views/side.js';
import { TodayView } from './views/today.js';
import { openItemDialog, openSettings } from './dialogs.js';

const VIEWS = [
  ['month', '月'],
  ['week', '週'],
  ['board', 'タスク'],
];

function go(date) {
  setCursor(date);
  ensureWindow();
}

const step = dir => go(state.ui.view === 'month' ? addMonths(state.ui.cursor, dir) : addDays(state.ui.cursor, dir * 7));

function rangeTitle() {
  const { view, cursor } = state.ui;
  return view === 'month' ? fmtMonth(cursor) : fmtWeekRange(startOfWeek(cursor, state.settings.weekStart));
}

function SyncChip() {
  const { auth, sync, settings } = state;
  const pending = pendingCount();
  if (auth.status === 'connected') {
    const label = sync.busy ? '同期中…' : sync.error ? '同期エラー' : pending ? `未反映 ${pending} 件` : sync.lastSync ? `同期済み ${toHM(new Date(sync.lastSync))}` : '接続済み';
    return h(
      'button',
      { class: `chipbtn${sync.error ? ' warn' : ''}${sync.busy ? ' busy' : ''}`, title: sync.error || '今すぐ Google と同期', 'aria-label': label, onclick: () => syncNow() },
      icon('sync', 15),
      h('span', { class: 'chip-label' }, label),
    );
  }
  if (auth.status === 'connecting') return h('span', { class: 'chipbtn busy' }, icon('sync', 15), '接続中…');
  if (auth.status === 'expired') {
    return h(
      'button',
      { class: 'chipbtn warn', title: 'Google との接続をやり直す', 'aria-label': 'Google に再接続', onclick: () => connect() },
      icon('cloud', 15),
      h('span', { class: 'chip-label' }, 'Google に再接続'),
    );
  }
  return h(
    'button',
    { class: 'chipbtn', onclick: () => (settings.clientId ? connect() : openSettings()) },
    icon('cloud', 15),
    'Google と連携',
  );
}

function Topbar() {
  const { view } = state.ui;
  return h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }), 'Planner'),
    h(
      'div',
      { class: 'nav' },
      h('button', { class: 'btn', onclick: () => go(today()) }, '今日'),
      h('button', { class: 'btn icon-btn ghost', 'aria-label': '前へ', onclick: () => step(-1) }, icon('left')),
      h('button', { class: 'btn icon-btn ghost', 'aria-label': '次へ', onclick: () => step(1) }, icon('right')),
      h('h1', { class: 'range' }, rangeTitle()),
    ),
    h(
      'div',
      { class: 'segs tabs', role: 'tablist', 'aria-label': '表示の切り替え' },
      VIEWS.map(([value, label]) =>
        h('button', { class: `seg${view === value ? ' on' : ''}`, role: 'tab', 'aria-selected': String(view === value), onclick: () => setView(value) }, label),
      ),
    ),
    h(
      'div',
      { class: 'actions' },
      SyncChip(),
      h('button', { class: 'btn primary', onclick: () => openItemDialog() }, icon('plus', 16), '追加'),
      h('button', { class: 'btn icon-btn ghost', 'aria-label': '設定', title: '設定', onclick: openSettings }, icon('settings')),
    ),
  );
}

function Banner() {
  const { auth, sync } = state;
  const pending = pendingCount();
  if (auth.status === 'expired') {
    return h(
      'div',
      { class: 'banner warn' },
      `Google との接続が切れています。${pending ? `未反映の変更 ${pending} 件は、` : '変更は'}再接続すると送られます。`,
      h('button', { class: 'btn small', onclick: () => connect() }, '再接続'),
    );
  }
  if (auth.error && state.settings.clientId) return h('div', { class: 'banner warn' }, auth.error, h('button', { class: 'btn small', onclick: openSettings }, '設定を開く'));
  if (auth.status === 'connected' && sync.error) {
    return h('div', { class: 'banner warn' }, sync.error, h('button', { class: 'btn small', onclick: () => syncNow() }, '再試行'));
  }
  if (auth.status === 'connected' && sync.notesError) {
    // 予定・タスクは同期できているが、メモだけ他の端末と同期できていない
    return sync.notesError === 'permission'
      ? h(
          'div',
          { class: 'banner warn' },
          'メモを他の端末と同期するには、Google への接続をやり直して許可を追加してください。',
          h('button', { class: 'btn small', onclick: () => connect() }, '接続し直す'),
        )
      : h(
          'div',
          { class: 'banner warn' },
          `メモを同期できませんでした（${sync.notesError}）`,
          h('button', { class: 'btn small', onclick: () => syncNow() }, '再試行'),
        );
  }
  return null;
}

// today.html で開いたときは、小さな窓に置いておく「今日の一覧」だけを表示する
const WIDGET = document.documentElement.dataset.mode === 'today';

function WidgetBar() {
  const t = today();
  return h(
    'header',
    { class: 'topbar widget-bar' },
    h('h1', { class: 'range' }, fmtDay(t)),
    h(
      'div',
      { class: 'actions' },
      SyncChip(),
      h('button', { class: 'btn primary icon-btn', 'aria-label': '追加', title: '追加', onclick: () => openItemDialog({ defaults: { date: t } }) }, icon('plus', 16)),
      h('a', { class: 'btn icon-btn ghost', href: './', 'aria-label': 'Planner 全体を開く', title: 'Planner 全体を開く' }, icon('calendar')),
    ),
  );
}

function App() {
  if (WIDGET) {
    return h('div', { class: 'app widget' }, WidgetBar(), Banner(), h('div', { class: 'body widget-body', dataset: { sk: 'widget' } }, TodayView()));
  }
  const { view } = state.ui;
  const content = view === 'month' ? MonthView() : view === 'week' ? WeekView() : BoardView();
  return h(
    'div',
    { class: 'app' },
    Topbar(),
    Banner(),
    h(
      'div',
      {
        class: `body view-${view}`,
        // スマホのタスク表示は 1 週間を縦に並べるので、今日の位置から始める
        dataset: { sk: `body:${view}`, ...(view === 'board' && isPhone() ? { skInitTop: '.board-col.today', skInitOffset: '8' } : {}) },
      },
      h('main', { class: 'main' }, content),
      SidePanel(),
    ),
  );
}

const app = mount(document.getElementById('app'), App);
subscribe(() => app.update());
window.addEventListener('resize', () => app.update());
setInterval(() => app.update(), 60_000); // 現在時刻の線と「今日」を更新する
initSync();

// インターネット上に置いた版では、電波がなくても開けるようにする（この Mac 上で動かす版では使わない）
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
