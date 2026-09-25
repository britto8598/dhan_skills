/** TPO / Market Profile construction with split/merge segments. */
import type { Bar } from "../feed/protocol";
import { MIN_MS, istMidnight, sessionOpen } from "../sim/time";
import { valueArea } from "./profile";

export const TPO_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface TpoRow {
  p: number;
  periods: number[]; // period index per TPO (letter = TPO_LETTERS[idx])
}

export interface TpoProfile {
  start: number;
  end: number;
  row: number;
  rows: TpoRow[]; // ascending price
  total: number;
  maxCount: number;
  poc: number;
  vah: number;
  val: number;
  singles: number[];
  ibHigh: number | null;
  ibLow: number | null;
  open: number;
  close: number;
  high: number;
  low: number;
  days: number;
  periodStarts: number[]; // absolute start time of each period index seen (for split UI)
}

/** Boundaries are session opens, minus user merges, plus user splits. */
export function tpoSegments(bars: Bar[], merges: number[], splits: number[]): { start: number; end: number }[] {
  if (!bars.length) return [];
  const bset = new Set<number>();
  for (const b of bars) bset.add(sessionOpen(b.t));
  for (const m of merges) bset.delete(m);
  for (const s of splits) bset.add(s);
  const first = sessionOpen(bars[0].t);
  bset.add(first);
  const bounds = [...bset].filter((x) => x >= first).sort((a, b) => a - b);
  const end = bars[bars.length - 1].t + MIN_MS;
  return bounds.map((s, i) => ({ start: s, end: i + 1 < bounds.length ? bounds[i + 1] : end })).filter((s) => s.end > s.start);
}

export function buildTpo(bars: Bar[], start: number, end: number, periodMin: number, row: number, ibPeriods = 2): TpoProfile | null {
  const pMs = periodMin * MIN_MS;
  const rows = new Map<number, number[]>();
  const periodHiLo = new Map<string, [number, number, number]>(); // day|idx -> hi, lo, periodStart
  let open = NaN;
  let close = NaN;
  let high = -Infinity;
  let low = Infinity;
  const daySet = new Set<number>();
  const snap = (p: number) => Math.round(Math.floor(p / row + 1e-9) * row * 1e6) / 1e6;
  for (const b of bars) {
    if (b.t < start || b.t >= end) continue;
    if (Number.isNaN(open)) open = b.o;
    close = b.c;
    high = Math.max(high, b.h);
    low = Math.min(low, b.l);
    const so = sessionOpen(b.t);
    const idx = Math.max(0, Math.floor((b.t - so) / pMs));
    const day = istMidnight(b.t);
    daySet.add(day);
    const key = `${day}|${idx}`;
    const hl = periodHiLo.get(key);
    if (hl) {
      hl[0] = Math.max(hl[0], b.h);
      hl[1] = Math.min(hl[1], b.l);
    } else periodHiLo.set(key, [b.h, b.l, so + idx * pMs]);
  }
  if (!periodHiLo.size) return null;
  const periodStarts: number[] = [];
  for (const [key, [hi, lo, ps]] of periodHiLo) {
    const idx = Number(key.split("|")[1]);
    periodStarts.push(ps);
    for (let p = snap(lo); p <= hi + 1e-9; p = Math.round((p + row) * 1e6) / 1e6) {
      let arr = rows.get(p);
      if (!arr) rows.set(p, (arr = []));
      arr.push(idx);
    }
  }
  const counts = new Map<number, number>();
  let total = 0;
  let maxCount = 0;
  const outRows: TpoRow[] = [...rows.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([p, periods]) => {
      periods.sort((a, b) => a - b);
      counts.set(p, periods.length);
      total += periods.length;
      maxCount = Math.max(maxCount, periods.length);
      return { p, periods };
    });
  const va = valueArea(counts, row)!;
  const singles: number[] = [];
  for (let i = 1; i < outRows.length - 1; i++) if (outRows[i].periods.length === 1) singles.push(outRows[i].p);
  // Initial balance: first `ibPeriods` periods of the first day in the segment (only if the segment starts at the open)
  let ibHigh: number | null = null;
  let ibLow: number | null = null;
  const firstDay = Math.min(...daySet);
  if (sessionOpen(firstDay + 12 * 3600_000) === start) {
    for (let i = 0; i < ibPeriods; i++) {
      const hl = periodHiLo.get(`${firstDay}|${i}`);
      if (!hl) continue;
      ibHigh = ibHigh === null ? hl[0] : Math.max(ibHigh, hl[0]);
      ibLow = ibLow === null ? hl[1] : Math.min(ibLow, hl[1]);
    }
  }
  return {
    start,
    end,
    row,
    rows: outRows,
    total,
    maxCount,
    ...va,
    singles,
    ibHigh,
    ibLow,
    open,
    close,
    high,
    low,
    days: daySet.size,
    periodStarts: [...new Set(periodStarts)].sort((a, b) => a - b),
  };
}

/** Auto TPO row size: ~`targetRows` rows across the day's range, snapped to a nice multiple of `base`. */
export function autoTpoRow(bars: Bar[], base: number, targetRows = 45): number {
  let hi = -Infinity;
  let lo = Infinity;
  const recent = bars.slice(-375);
  for (const b of recent) {
    hi = Math.max(hi, b.h);
    lo = Math.min(lo, b.l);
  }
  const want = (hi - lo) / targetRows;
  for (const k of [1, 2, 4, 5, 10, 20, 25, 40, 50, 100, 200, 500]) if (base * k >= want) return base * k;
  return base * 1000;
}
