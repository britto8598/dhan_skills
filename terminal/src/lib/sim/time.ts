/** IST session helpers. All timestamps are epoch milliseconds (UTC); IST = UTC+05:30, no DST. */

export const IST_OFFSET_MS = 19_800_000;
export const MIN_MS = 60_000;
export const DAY_MS = 86_400_000;
export const SESSION_OPEN_MIN = 9 * 60 + 15;
export const SESSION_CLOSE_MIN = 15 * 60 + 30;
export const SESSION_MINUTES = SESSION_CLOSE_MIN - SESSION_OPEN_MIN; // 375

export function istMidnight(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

export function sessionOpen(ms: number): number {
  return istMidnight(ms) + SESSION_OPEN_MIN * MIN_MS;
}

export function sessionClose(ms: number): number {
  return istMidnight(ms) + SESSION_CLOSE_MIN * MIN_MS;
}

/** 0 = Sunday ... 6 = Saturday, in IST. */
export function istDow(ms: number): number {
  return new Date(ms + IST_OFFSET_MS).getUTCDay();
}

export function istMinuteOfDay(ms: number): number {
  return Math.floor(((ms + IST_OFFSET_MS) % DAY_MS) / MIN_MS);
}

export function isWeekday(ms: number): boolean {
  const d = istDow(ms);
  return d !== 0 && d !== 6;
}

/** Midnight (IST) of the previous weekday before the day containing `ms`. */
export function prevWeekdayMidnight(ms: number): number {
  let m = istMidnight(ms) - DAY_MS;
  while (!isWeekday(m + 12 * 3600_000)) m -= DAY_MS;
  return m;
}

export function nextWeekdayMidnight(ms: number): number {
  let m = istMidnight(ms) + DAY_MS;
  while (!isWeekday(m + 12 * 3600_000)) m += DAY_MS;
  return m;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

export function fmtTime(ms: number, withSec = false): string {
  const d = new Date(ms + IST_OFFSET_MS);
  const base = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return withSec ? `${base}:${pad(d.getUTCSeconds())}` : base;
}

export function fmtDate(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]}`;
}

/** YYMMDD in IST, the expiry format used by the Scalper inputs. */
export function yymmdd(ms: number): string {
  const d = new Date(ms + IST_OFFSET_MS);
  return `${pad(d.getUTCFullYear() % 100)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

export function parseYymmdd(s: string): number | null {
  if (!/^\d{6}$/.test(s)) return null;
  const y = 2000 + Number(s.slice(0, 2));
  const m = Number(s.slice(2, 4)) - 1;
  const d = Number(s.slice(4, 6));
  return Date.UTC(y, m, d) - IST_OFFSET_MS;
}

/** "HH:MM" → minutes of day. */
export function parseHm(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
