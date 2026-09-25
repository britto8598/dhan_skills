/** Volume profile + value area (70%) shared by volume profile, TPO and fixed-range profiles. */
import type { Bar } from "../feed/protocol";

export interface ValueArea {
  poc: number;
  val: number;
  vah: number;
}

/**
 * Value area from a price→weight histogram. Starts at the POC and repeatedly adds
 * the heavier adjacent row until `pct` of the total is covered.
 */
export function valueArea(hist: Map<number, number>, row: number, pct = 0.7): ValueArea | null {
  if (!hist.size) return null;
  const prices = [...hist.keys()].sort((a, b) => a - b);
  const lo0 = prices[0];
  const hi0 = prices[prices.length - 1];
  const mid = (lo0 + hi0) / 2;
  let poc = prices[0];
  let best = -1;
  let total = 0;
  for (const p of prices) {
    const w = hist.get(p)!;
    total += w;
    if (w > best || (w === best && Math.abs(p - mid) < Math.abs(poc - mid))) {
      best = w;
      poc = p;
    }
  }
  const key = (p: number) => Math.round(p * 1e6) / 1e6;
  let lo = poc;
  let hi = poc;
  let acc = hist.get(poc)!;
  const target = total * pct;
  while (acc < target && (lo > lo0 || hi < hi0)) {
    const up = hi < hi0 ? hist.get(key(hi + row)) ?? 0 : -1;
    const dn = lo > lo0 ? hist.get(key(lo - row)) ?? 0 : -1;
    if (up >= dn) {
      hi = key(hi + row);
      acc += Math.max(up, 0);
    } else {
      lo = key(lo - row);
      acc += Math.max(dn, 0);
    }
  }
  return { poc, val: lo, vah: hi };
}

export interface VolumeProfile extends ValueArea {
  row: number;
  rows: { p: number; v: number; d: number }[];
  max: number;
  total: number;
}

export function volumeProfile(bars: Bar[], row: number, pct = 0.7): VolumeProfile | null {
  const vol = new Map<number, number>();
  const del = new Map<number, number>();
  for (const b of bars) {
    const c = b.cells;
    if (!c.length) {
      // bars without cells (indices without volume): spread range evenly
      const p = Math.round(Math.floor(b.c / row) * row * 1e6) / 1e6;
      vol.set(p, (vol.get(p) ?? 0) + (b.v || 1));
      continue;
    }
    for (let i = 0; i < c.length; i += 3) {
      const p = Math.round(Math.floor(c[i] / row + 1e-9) * row * 1e6) / 1e6;
      vol.set(p, (vol.get(p) ?? 0) + c[i + 1] + c[i + 2]);
      del.set(p, (del.get(p) ?? 0) + c[i + 2] - c[i + 1]);
    }
  }
  const va = valueArea(vol, row, pct);
  if (!va) return null;
  let max = 0;
  let total = 0;
  const rows = [...vol.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([p, v]) => {
      max = Math.max(max, v);
      total += v;
      return { p, v, d: del.get(p) ?? 0 };
    });
  return { ...va, row, rows, max, total };
}
