// 予定・タスクの編集ダイアログと、設定ダイアログ。
import { h, mount } from './dom.js';
import { state, subscribe, createItem, updateItem, deleteItem, restoreItem, updateSettings, exportData, importData, pendingCount } from './store.js';
import { connect, disconnect, syncNow, saveSecret, usingBackend } from './sync.js';
import { redirectUri } from './google.js';
import { addDays, diffDays, timeToMin, minToTime, today, toHM } from './dates.js';
import { icon, toast } from './ui.js';

function openModal(build, { wide = false } = {}) {
  let cleanup = null;
  const overlay = h('div', { class: 'overlay', onmousedown: e => e.target === overlay && close() });
  const onKey = e => {
    if (e.key === 'Escape' && !e.isComposing) {
      e.stopPropagation();
      close();
    }
  };
  function close() {
    document.removeEventListener('keydown', onKey, true);
    cleanup?.();
    overlay.remove();
  }
  const dialog = h('div', { class: `dialog${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' });
  overlay.append(dialog);
  document.getElementById('overlays').append(overlay);
  document.addEventListener('keydown', onKey, true);
  cleanup = build(dialog, close) || null;
  return close;
}

const Field = (label, ...controls) =>
  h('div', { class: 'field' }, h('span', { class: 'field-label' }, label), h('div', { class: 'field-body' }, controls));

function defaultTimes() {
  const n = new Date();
  const start = Math.min(Math.ceil((n.getHours() * 60 + n.getMinutes() + 1) / 30) * 30, 22 * 60);
  return [minToTime(start), minToTime(start + 60)];
}

// ---- 予定・タスクの編集 ----

export function openItemDialog({ item = null, defaults = {} } = {}) {
  const isNew = !item;
  const base = item
    ? { ...item }
    : { kind: 'task', title: '', description: '', date: state.ui.cursor, endDate: null, startTime: null, endTime: null, done: false, ...defaults };
  const ro = !!base.readOnly;
  const kindLocked = !isNew && !!base.google; // Google 上では予定とタスクが別物なので、送信後は種類を変えない
  const connected = state.auth.status === 'connected';
  const writableCals = state.calendars.filter(c => c.writable);
  const [defStart, defEnd] = defaultTimes();
  let kind = base.kind;

  openModal((dialog, close) => {
    const fTitle = h('input', { type: 'text', class: 'f-title', placeholder: 'タイトル', 'aria-label': 'タイトル', value: base.title, disabled: ro });
    const fDate = h('input', { type: 'date', 'aria-label': '日付', value: base.date || '', disabled: ro });
    const fAllDay = h('input', { type: 'checkbox', checked: !base.startTime, disabled: ro });
    const fStart = h('input', { type: 'time', 'aria-label': '開始時刻', value: base.startTime || defStart, disabled: ro });
    const fEnd = h('input', { type: 'time', 'aria-label': '終了時刻', value: base.endTime || defEnd, disabled: ro });
    const fEndDate = h('input', { type: 'date', 'aria-label': '終了日', value: base.endDate || base.date || '', disabled: ro });
    const fDone = h('input', { type: 'checkbox', checked: !!base.done, disabled: ro });
    const fDesc = h('textarea', { class: 'f-desc', rows: 4, placeholder: '詳細', 'aria-label': '詳細', value: base.description || '', disabled: ro });
    const fCal = h(
      'select',
      { 'aria-label': 'カレンダー', value: state.settings.defaultCalendarId || '' },
      writableCals.map(c => h('option', { value: c.id }, c.name)),
    );
    const fList = h(
      'select',
      { 'aria-label': 'リスト', value: state.settings.defaultTaskListId || '' },
      state.taskLists.map(l => h('option', { value: l.id }, l.name)),
    );
    const error = h('p', { class: 'form-error', role: 'alert', hidden: true });

    // 開始を動かしたら、長さを保ったまま終了も動かす
    let prevDate = fDate.value;
    let prevStart = fStart.value;
    fDate.addEventListener('change', () => {
      if (fDate.value && prevDate && fEndDate.value) fEndDate.value = addDays(fEndDate.value, diffDays(prevDate, fDate.value));
      else if (fDate.value) fEndDate.value = fDate.value;
      prevDate = fDate.value;
    });
    fStart.addEventListener('change', () => {
      if (fStart.value && prevStart && fEnd.value) {
        const length = (timeToMin(fEnd.value) - timeToMin(prevStart) + 1440) % 1440 || 60;
        fEnd.value = minToTime((timeToMin(fStart.value) + length) % 1440);
      }
      prevStart = fStart.value;
    });

    const kindTab = (value, label) =>
      h('button', {
        type: 'button',
        class: 'seg',
        disabled: ro || kindLocked,
        dataset: { kind: value },
        onclick: () => {
          kind = value;
          refresh();
        },
      }, label);
    const kinds = h('div', { class: 'segs', role: 'group', 'aria-label': '種類' }, kindTab('task', 'タスク'), kindTab('event', '予定'));

    const rowAllDay = h('label', { class: 'inline' }, fAllDay, '終日');
    const rowTime = Field('時間', fStart, h('span', { class: 'dash' }, '–'), fEnd);
    const rowEnd = Field('終了日', fEndDate);
    const rowDone = h('label', { class: 'inline done-toggle' }, fDone, '完了');
    const rowCal = Field('カレンダー', fCal);
    const rowList = Field('リスト', fList);
    const hint = h('p', { class: 'form-hint' });

    function refresh() {
      const isEvent = kind === 'event';
      kinds.querySelectorAll('.seg').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
      rowAllDay.hidden = !isEvent;
      rowTime.hidden = !isEvent || fAllDay.checked;
      rowEnd.hidden = !isEvent;
      rowDone.hidden = isEvent;
      rowCal.hidden = !(isNew && isEvent && connected && writableCals.length > 1);
      rowList.hidden = !(isNew && !isEvent && connected && state.taskLists.length > 1);
      const hints = [];
      if (ro) hints.push('この予定は閲覧のみです（編集できないカレンダーの予定）。');
      else if (base.google?.recurring) hints.push('繰り返し予定です。ここでの変更はこの回だけに反映されます。');
      if (!ro && !isEvent) hints.push(fDate.value ? '' : '日付を空にすると「日付なしのタスク」に入ります。');
      hint.textContent = hints.filter(Boolean).join(' ');
      hint.hidden = !hint.textContent;
    }
    fAllDay.addEventListener('change', refresh);
    fDate.addEventListener('change', refresh);

    function save() {
      const fields = { kind, title: fTitle.value.trim() || '(無題)', description: fDesc.value.trim() };
      if (kind === 'event') {
        const date = fDate.value;
        if (!date) {
          error.textContent = '予定には日付が必要です。';
          error.hidden = false;
          fDate.focus();
          return;
        }
        let endDate = fEndDate.value && fEndDate.value >= date ? fEndDate.value : date;
        let startTime = null;
        let endTime = null;
        if (!fAllDay.checked) {
          startTime = fStart.value || defStart;
          endTime = fEnd.value || startTime;
          if (endDate === date && endTime < startTime) {
            endDate = addDays(date, 1); // 日をまたぐ予定
          } else if (endDate === date && endTime === startTime) {
            const end = timeToMin(startTime) + 60;
            endTime = minToTime(end % 1440);
            if (end >= 1440) endDate = addDays(date, 1);
          }
        }
        Object.assign(fields, { date, endDate, startTime, endTime, done: false });
        if (isNew && !rowCal.hidden) fields.target = fCal.value;
      } else {
        Object.assign(fields, { date: fDate.value || null, endDate: null, startTime: null, endTime: null, done: fDone.checked });
        if (isNew && !rowList.hidden) fields.target = fList.value;
      }
      if (isNew) createItem(fields);
      else updateItem(item.id, fields);
      close();
    }

    function remove() {
      const snapshot = deleteItem(item.id);
      close();
      if (snapshot) toast(`「${snapshot.title}」を削除しました`, { action: '元に戻す', onAction: () => restoreItem(snapshot) });
    }

    const form = h(
      'form',
      {
        class: 'item-form',
        onsubmit: e => {
          e.preventDefault();
          if (!ro) save();
        },
        onkeydown: e => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !ro) {
            e.preventDefault();
            save();
          }
        },
      },
      h(
        'div',
        { class: 'dialog-head' },
        kinds,
        h('button', { type: 'button', class: 'btn icon-btn ghost', 'aria-label': '閉じる', onclick: close }, icon('close')),
      ),
      fTitle,
      Field('日付', fDate, rowAllDay, rowDone),
      rowTime,
      rowEnd,
      rowCal,
      rowList,
      fDesc,
      hint,
      error,
      h(
        'div',
        { class: 'dialog-foot' },
        !isNew && !ro ? h('button', { type: 'button', class: 'btn danger', onclick: remove }, icon('trash', 16), '削除') : null,
        base.google?.htmlLink
          ? h('a', { class: 'btn ghost', href: base.google.htmlLink, target: '_blank', rel: 'noopener noreferrer' }, icon('link', 16), 'Google で開く')
          : null,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'btn', onclick: close }, ro ? '閉じる' : 'キャンセル'),
        ro ? null : h('button', { type: 'submit', class: 'btn primary' }, isNew ? '追加' : '保存'),
      ),
    );
    dialog.append(form);
    refresh();
    if (!ro) {
      fTitle.focus();
      if (!isNew) fTitle.select();
    }
  });
}

// ---- 設定 ----

const STATUS_TEXT = {
  disconnected: '未接続',
  connecting: '接続中…',
  connected: '接続済み',
  expired: '接続の有効期限が切れています',
};

export function openSettings() {
  openModal((dialog, close) => {
    const view = mount(dialog, () => SettingsBody(close));
    const unsubscribe = subscribe(() => view.update());
    return () => {
      unsubscribe();
      view.destroy();
    };
  }, { wide: true });
}

function SettingsBody(close) {
  const { auth, settings, sync } = state;
  const isConnected = auth.status === 'connected';
  const canKeep = !!state.backend; // 同梱サーバーで開いているときだけ、接続を保つ設定が使える
  const durable = usingBackend();
  const saveClientId = () => {
    const input = document.querySelector('[data-fk="clientId"]');
    if (input && input.value.trim() !== settings.clientId) updateSettings({ clientId: input.value.trim() });
  };

  return h(
    'div',
    { class: 'settings' },
    h(
      'div',
      { class: 'dialog-head' },
      h('h2', null, '設定'),
      h('button', { class: 'btn icon-btn ghost', 'aria-label': '閉じる', onclick: close }, icon('close')),
    ),

    h(
      'section',
      { class: 'set-sec' },
      h('h3', null, 'Google カレンダー連携'),
      h(
        'p',
        { class: `status status-${auth.status}` },
        h('span', { class: 'status-dot' }),
        STATUS_TEXT[auth.status],
        settings.accountHint && auth.status !== 'disconnected' ? `（${settings.accountHint}）` : '',
        isConnected && sync.lastSync ? `・最終同期 ${toHM(new Date(sync.lastSync))}` : '',
      ),
      auth.error ? h('p', { class: 'form-error' }, auth.error) : null,
      isConnected && sync.error ? h('p', { class: 'form-error' }, sync.error) : null,

      isConnected
        ? [
            h(
              'p',
              { class: 'form-hint' },
              durable
                ? '接続を保つ設定が有効です。時間が経っても、操作なしで自動的に更新されます。'
                : `いまの接続は約 1 時間で切れます。${canKeep ? '下にクライアントシークレットを保存すると、切れなくなります。' : '切れたら「再接続」を押してください。'}`,
            ),
            h(
              'p',
              { class: 'form-hint' },
              sync.notesError
                ? 'メモ: まだ他の端末と同期できていません（画面上部の案内を確認してください）。'
                : 'メモ: Google ドライブのアプリ専用領域に保存され、他の端末と同期されます。',
            ),
            h(
              'div',
              { class: 'btn-row' },
              h('button', { class: 'btn', disabled: sync.busy, onclick: () => syncNow() }, icon('sync', 16), sync.busy ? '同期中…' : '今すぐ同期'),
              h('button', { class: 'btn', onclick: () => disconnect() }, '接続を解除'),
            ),
            !durable && canKeep ? SecretRow(saveClientId, { reconnect: true }) : null,
            CalendarList(),
          ]
        : [
            SetupGuide(),
            Field(
              'クライアント ID',
              h('input', {
                type: 'text',
                class: 'grow',
                placeholder: 'xxxxxxxx.apps.googleusercontent.com',
                'aria-label': 'OAuth クライアント ID',
                value: settings.clientId,
                spellcheck: false,
                autocomplete: 'off',
                dataset: { fk: 'clientId', keep: '1' },
                onchange: saveClientId,
              }),
            ),
            canKeep ? (state.backend.hasSecret ? SecretSaved() : SecretRow(saveClientId)) : null,
            h(
              'div',
              { class: 'btn-row' },
              h(
                'button',
                {
                  class: 'btn primary',
                  disabled: auth.status === 'connecting',
                  onclick: () => {
                    saveClientId();
                    connect();
                  },
                },
                auth.status === 'expired' ? 'Google に再接続' : 'Google と接続',
              ),
            ),
            pendingCount()
              ? h('p', { class: 'form-hint' }, `このアプリで作った ${pendingCount()} 件は、接続すると Google に送られます。`)
              : null,
          ],
    ),

    h(
      'section',
      { class: 'set-sec' },
      h('h3', null, '表示'),
      Field(
        '週の始まり',
        h(
          'div',
          { class: 'segs' },
          [[1, '月曜日'], [0, '日曜日']].map(([value, label]) =>
            h('button', { class: `seg${settings.weekStart === value ? ' on' : ''}`, onclick: () => updateSettings({ weekStart: value }) }, label),
          ),
        ),
      ),
    ),

    h(
      'section',
      { class: 'set-sec' },
      h('h3', null, 'バックアップ'),
      h('p', { class: 'form-hint' }, 'Google に接続している間、メモは Google ドライブのアプリ専用領域にも保存され、他の端末と同期されます。未接続のときはこのブラウザの中だけに保存されるので、ブラウザのデータを消す前に書き出しておくと安心です。'),
      h(
        'div',
        { class: 'btn-row' },
        h('button', { class: 'btn', onclick: downloadBackup }, 'ファイルに書き出す'),
        h('button', { class: 'btn', onclick: pickBackup }, 'ファイルから読み込む'),
      ),
    ),
  );
}

/** クライアントシークレットの入力欄。値はこの Mac の同梱サーバーにだけ送られ、ブラウザには保存しない */
function SecretRow(saveClientId, { reconnect = false } = {}) {
  const save = async () => {
    const input = document.querySelector('[data-fk="clientSecret"]');
    const secret = input?.value.trim();
    saveClientId();
    const clientId = state.settings.clientId.trim();
    if (!clientId || !secret) return toast('クライアント ID とクライアントシークレットの両方を入力してください');
    try {
      await saveSecret(clientId, secret);
      input.value = '';
      if (reconnect) connect();
    } catch (e) {
      toast(`保存できませんでした: ${e.message}`);
    }
  };
  return [
    Field(
      'シークレット',
      h('input', {
        type: 'password',
        class: 'grow',
        placeholder: 'GOCSPX-…（任意）',
        'aria-label': 'クライアントシークレット',
        autocomplete: 'off',
        spellcheck: false,
        dataset: { fk: 'clientSecret', keep: '1' },
        onkeydown: e => e.key === 'Enter' && !e.isComposing && save(),
      }),
      h('button', { class: 'btn', onclick: save }, reconnect ? '保存して接続し直す' : '保存'),
    ),
    h(
      'p',
      { class: 'form-hint' },
      '保存すると、接続が 1 時間で切れなくなります。シークレットはこの Mac の中（~/.config/planner）だけに保存されます。',
    ),
  ];
}

function SecretSaved() {
  return h(
    'p',
    { class: 'status status-connected' },
    h('span', { class: 'status-dot' }),
    'クライアントシークレット保存済み（接続が切れなくなります）',
    h(
      'button',
      {
        class: 'btn small',
        onclick: () => saveSecret(state.settings.clientId.trim(), '').catch(e => toast(`削除できませんでした: ${e.message}`)),
      },
      '削除',
    ),
  );
}

function SetupGuide() {
  const step = (...content) => h('li', null, content);
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  return h(
    'details',
    { class: 'guide', open: !state.settings.clientId },
    h('summary', null, '初回だけ必要な準備（5 分ほど）'),
    h(
      'ol',
      null,
      step(link('https://console.cloud.google.com/projectcreate', 'Google Cloud Console'), ' でプロジェクトを作成します（無料）。'),
      step(
        '「API とサービス → ライブラリ」で ',
        link('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Google Calendar API'),
        '・',
        link('https://console.cloud.google.com/apis/library/tasks.googleapis.com', 'Google Tasks API'),
        '・',
        link('https://console.cloud.google.com/apis/library/drive.googleapis.com', 'Google Drive API'),
        ' を有効にします（Drive はメモの同期に使います）。',
      ),
      step(
        link('https://console.cloud.google.com/auth/overview', 'Google Auth Platform'),
        ' で同意画面を設定します。対象は「外部」、テストユーザーに自分の Google アカウントを追加します。',
      ),
      step(
        '「クライアント → クライアントを作成」で種類「ウェブ アプリケーション」を選び、「承認済みの JavaScript 生成元」に ',
        h('code', null, location.origin),
        '、「承認済みのリダイレクト URI」に ',
        h('code', null, redirectUri()),
        ' を追加します。',
      ),
      step('発行されたクライアント ID を下に貼り付けて「Google と接続」を押します。'),
      state.backend
        ? step(
            '（接続を切れなくする場合）同じクライアントの「承認済みのリダイレクト URI」に ',
            h('code', null, state.backend.redirectUri),
            ' を追加し、クライアント シークレットを発行して下の欄に保存します。',
          )
        : null,
    ),
  );
}

function CalendarList() {
  const { settings, calendars, taskLists } = state;
  const hidden = new Set(settings.hiddenCalendars);
  const toggle = (id, show) => {
    const next = new Set(settings.hiddenCalendars);
    if (show) next.delete(id);
    else next.add(id);
    updateSettings({ hiddenCalendars: [...next] });
    if (show) syncNow();
  };
  return [
    h('h4', null, '表示するカレンダー'),
    h(
      'div',
      { class: 'cal-list' },
      calendars.map(c =>
        h(
          'label',
          { class: 'cal-item' },
          h('input', { type: 'checkbox', checked: !hidden.has(c.id), onchange: e => toggle(c.id, e.target.checked) }),
          h('span', { class: 'cal-dot', style: { background: c.color || 'var(--accent)' } }),
          h('span', { class: 'cal-name' }, c.name),
          c.writable ? null : h('span', { class: 'cal-ro' }, '閲覧のみ'),
        ),
      ),
    ),
    Field(
      '予定の追加先',
      h(
        'select',
        { class: 'grow', value: settings.defaultCalendarId || '', onchange: e => updateSettings({ defaultCalendarId: e.target.value }) },
        calendars.filter(c => c.writable).map(c => h('option', { value: c.id }, c.name)),
      ),
    ),
    Field(
      'タスクの追加先',
      h(
        'select',
        { class: 'grow', value: settings.defaultTaskListId || '', onchange: e => updateSettings({ defaultTaskListId: e.target.value }) },
        taskLists.map(l => h('option', { value: l.id }, l.name)),
      ),
    ),
  ];
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(exportData(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: `planner-backup-${today()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickBackup() {
  const input = h('input', {
    type: 'file',
    accept: 'application/json,.json',
    onchange: async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const result = importData(JSON.parse(await file.text()));
        toast(`メモ ${result.notes} 件、予定・タスク ${result.items} 件を読み込みました`);
      } catch (e) {
        toast(`読み込めませんでした: ${e.message}`);
      }
    },
  });
  input.click();
}
