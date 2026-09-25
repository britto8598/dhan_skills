/** Timeframe aggregation of 1-minute bars (buckets aligned to the 09:15 session open). */
import type { Bar } from "../feed/protocol";
import { MIN_MS, sessionOpen } from "../sim/time";

export interface AggBar extends Bar {
  /** 1-minute bars inside this bar (for the Order Flow Matrix). */
  subs: Bar[];
  /** index of the first sub bar in the source array */
  i0: number;
}

export function bucketStart(t: number, tfMin: number): number {
  if (tfMin <= 1) return t;
  const open = sessionOpen(t);
  if (t < open) return t;
  return open + Math.floor((t - open) / (tfMin * MIN_MS)) * tfMin * MIN_MS;
}

export function mergeCells(bars: Bar[]): number[] {
  if (bars.length === 1) return bars[0].cells;
  const m = new Map<number, [number, number]>();
  for (const b of bars) {
    const c = b.cells;
    for (let i = 0; i < c.length; i += 3) {
      const e = m.get(c[i]);
      if (e) {
        e[0] += c[i + 1];
        e[1] += c[i + 2];
      } else m.set(c[i], [c[i + 1], c[i + 2]]);
    }
  }
  const keys = [...m.keys()].sort((a, b) => a - b);
  const out: number[] = [];
  for (const k of keys) {
    const e = m.get(k)!;
    out.push(k, e[0], e[1]);
  }
  return out;
}

export function mergeBars(t: number, subs: Bar[], i0: number): AggBar {
  let h = -Infinity;
  let l = Infinity;
  let v = 0;
  let d = 0;
  let n = 0;
  let dmin = 0;
  let dmax = 0;
  let oi: number | undefined;
  for (const b of subs) {
    if (b.h > h) h = b.h;
    if (b.l < l) l = b.l;
    dmin = Math.min(dmin, d + b.dmin);
    dmax = Math.max(dmax, d + b.dmax);
    v += b.v;
    d += b.d;
    n += b.n;
    if (b.oi !== undefined) oi = b.oi;
  }
  return { t, o: subs[0].o, h, l, c: subs[subs.length - 1].c, v, d, dmin, dmax, n, oi, cells: mergeCells(subs), subs, i0 };
}

interface CacheEntry {
  src: Bar[];
  out: AggBar[];
}

const cache = new Map<string, CacheEntry>();

/** Aggregated bars for `src` at `tfMin`. Incremental: only the last bucket onward is rebuilt. */
export function aggregate(key: string, src: Bar[], tfMin: number): AggBar[] {
  const ck = `${key}|${tfMin}`;
  let e = cache.get(ck);
  let start = 0;
  if (!e || e.src !== src || (e.out.length && e.out[e.out.length - 1].i0 >= src.length)) {
    e = { src, out: [] };
    cache.set(ck, e);
  } else if (e.out.length) {
    start = e.out[e.out.length - 1].i0;
    e.out.pop();
  }
  const out = e.out;
  let i = start;
  while (i < src.length) {
    const t = bucketStart(src[i].t, tfMin);
    let j = i + 1;
    while (j < src.length && bucketStart(src[j].t, tfMin) === t) j++;
    out.push(mergeBars(t, src.slice(i, j), i));
    i = j;
  }
  return out;
}

export function tfMinutes(tf: string): number {
  const m = /^(\d+)m$/.exec(tf);
  return m ? Number(m[1]) : 1;
}

export function rangeDays(range: string): number {
  const m = /^(\d+)D$/.exec(range);
  return m ? Number(m[1]) : 1;
}
