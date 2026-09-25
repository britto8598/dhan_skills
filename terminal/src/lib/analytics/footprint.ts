/** Footprint helpers: row regrouping, imbalance detection, auto row size. */
import type { Bar } from "../feed/protocol";

export interface FpRow {
  p: number; // row low price
  bid: number; // aggressive sell volume
  ask: number; // aggressive buy volume
  buyImb: boolean;
  sellImb: boolean;
}

export type ImbalanceMode = "diagonal" | "horizontal";

const rowCache = new WeakMap<Bar, { size: number; ratio: number; mode: ImbalanceMode; rows: FpRow[] }>();

function snap(p: number, size: number): number {
  return Math.round(Math.floor(p / size + 1e-9) * size * 1e6) / 1e6;
}

/** Group a bar's cells into rows of `size` price and flag imbalances (ratio 3 = 300%). */
export function footprintRows(bar: Bar, size: number, ratio: number, mode: ImbalanceMode, minVol = 0): FpRow[] {
  const hit = rowCache.get(bar);
  if (hit && hit.size === size && hit.ratio === ratio && hit.mode === mode) return hit.rows;
  const m = new Map<number, FpRow>();
  const c = bar.cells;
  for (let i = 0; i < c.length; i += 3) {
    const p = snap(c[i], size);
    let r = m.get(p);
    if (!r) m.set(p, (r = { p, bid: 0, ask: 0, buyImb: false, sellImb: false }));
    r.bid += c[i + 1];
    r.ask += c[i + 2];
  }
  const rows = [...m.values()].sort((a, b) => a.p - b.p);
  const byP = new Map(rows.map((r) => [r.p, r]));
  for (const r of rows) {
    if (mode === "horizontal") {
      r.buyImb = r.ask > minVol && r.ask >= ratio * Math.max(r.bid, 1);
      r.sellImb = r.bid > minVol && r.bid >= ratio * Math.max(r.ask, 1);
    } else {
      const below = byP.get(snap(r.p - size, size));
      const above = byP.get(snap(r.p + size, size));
      r.buyImb = r.ask > minVol && r.ask >= ratio * Math.max(below?.bid ?? 0, 1);
      r.sellImb = r.bid > minVol && r.bid >= ratio * Math.max(above?.ask ?? 0, 1);
    }
  }
  rowCache.set(bar, { size, ratio, mode, rows });
  return rows;
}

/** Runs of >= n consecutive imbalance rows → [low, high] zones. */
export function stackedZones(rows: FpRow[], size: number, side: "buy" | "sell", n = 3): [number, number][] {
  const out: [number, number][] = [];
  let start: number | null = null;
  let prev: number | null = null;
  let count = 0;
  for (const r of rows) {
    const on = side === "buy" ? r.buyImb : r.sellImb;
    if (on && prev !== null && Math.abs(r.p - prev - size) < 1e-6) {
      count++;
      prev = r.p;
      continue;
    }
    if (start !== null && count >= n) out.push([start, prev!]);
    if (on) {
      start = prev = r.p;
      count = 1;
    } else {
      start = prev = null;
      count = 0;
    }
  }
  if (start !== null && count >= n) out.push([start, prev!]);
  return out;
}

export function pocRow(rows: FpRow[]): FpRow | undefined {
  let best: FpRow | undefined;
  for (const r of rows) if (!best || r.bid + r.ask > best.bid + best.ask) best = r;
  return best;
}

const NICE = [1, 2, 4, 5, 10, 20, 40, 50, 100, 200, 400, 500, 1000];

/**
 * Row size for a target pixel height. `baseRow` is the stored cell granularity;
 * the result is a multiple of it. `pxPerPrice` = pixels per 1.0 of price.
 */
export function autoRowSize(pxPerPrice: number, baseRow: number, targetPx = 15): number {
  const want = targetPx / Math.max(pxPerPrice, 1e-9);
  for (const k of NICE) if (baseRow * k >= want) return baseRow * k;
  return baseRow * NICE[NICE.length - 1];
}

/** Manual "N-tick" row size, rounded up to a multiple of the stored granularity. */
export function tickRowSize(ticks: number, tickSize: number, baseRow: number): number {
  const raw = ticks * tickSize;
  return Math.max(baseRow, Math.round(Math.ceil(raw / baseRow - 1e-9) * baseRow * 1e6) / 1e6);
}
