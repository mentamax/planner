// 日付は 'YYYY-MM-DD'、時刻は 'HH:mm' の文字列で扱う（すべてローカルタイムゾーン）。

export const WD = ['日', '月', '火', '水', '木', '金', '土'];

export const pad = n => String(n).padStart(2, '0');
export const toYMD = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toHM = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const fromYMD = s => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const today = () => toYMD(new Date());

export const addDays = (s, n) => {
  const d = fromYMD(s);
  d.setDate(d.getDate() + n);
  return toYMD(d);
};

export const addMonths = (s, n) => {
  const d = fromYMD(s);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return toYMD(d);
};

export const diffDays = (a, b) => Math.round((fromYMD(b) - fromYMD(a)) / 86400000);
export const dow = s => fromYMD(s).getDay();

/** weekStart: 0 = 日曜始まり, 1 = 月曜始まり */
export const startOfWeek = (s, weekStart) => addDays(s, -((dow(s) - weekStart + 7) % 7));
export const weekDates = (s, weekStart) => {
  const st = startOfWeek(s, weekStart);
  return Array.from({ length: 7 }, (_, i) => addDays(st, i));
};

/** 月表示に必要な週（7日×4〜6行）を返す */
export function monthWeeks(s, weekStart) {
  const month = s.slice(0, 7);
  let st = startOfWeek(`${month}-01`, weekStart);
  const weeks = [];
  do {
    weeks.push(Array.from({ length: 7 }, (_, i) => addDays(st, i)));
    st = addDays(st, 7);
  } while (st.slice(0, 7) === month);
  return weeks;
}

/** 表示上の週に含まれる月曜日。週メモのキーに使うので、週の開始曜日設定を変えてもメモがずれない */
export function mondayOf(s, weekStart) {
  const st = startOfWeek(s, weekStart);
  return weekStart === 1 ? st : addDays(st, 1);
}

export function isoWeek(s) {
  const d = fromYMD(s);
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}

export const timeToMin = t => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
export const minToTime = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

export const fmtMonth = s => {
  const d = fromYMD(s);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
};
export const fmtMD = s => {
  const d = fromYMD(s);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
export const fmtDay = s => `${fmtMD(s)}(${WD[dow(s)]})`;
export function fmtWeekRange(start) {
  const a = fromYMD(start);
  const b = fromYMD(addDays(start, 6));
  const head = `${a.getFullYear()}年${a.getMonth() + 1}月${a.getDate()}日`;
  return a.getMonth() === b.getMonth()
    ? `${head} – ${b.getDate()}日`
    : `${head} – ${b.getMonth() + 1}月${b.getDate()}日`;
}
