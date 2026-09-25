/** Options money flow: per-strike aggressive flow, ₹ value, and institutional flow arrows. */
import type { MinuteFlow } from "../feed/protocol";
import { bucketStart } from "../data/aggregate";

export interface StrikeFlow {
  k: number;
  ceBuy: number; // lots
  ceSell: number;
  peBuy: number;
  peSell: number;
  ceBuyVal: number; // ₹
  ceSellVal: number;
  peBuyVal: number;
  peSellVal: number;
}

export interface FlowTotals {
  bull: number; // ₹ of bullish flow: put selling + call buying
  bear: number; // ₹ of bearish flow: call selling + put buying
}

/** Sum flows for minutes with from <= t <= to. */
export function aggregateFlows(flows: MinuteFlow[], from: number, to: number, lotSize: number): { strikes: StrikeFlow[]; totals: FlowTotals } {
  const m = new Map<number, StrikeFlow>();
  for (const f of flows) {
    if (f.t < from || f.t > to) continue;
    for (const [k, cb, cs, pb, ps, cp, pp] of f.rows) {
      let s = m.get(k);
      if (!s) m.set(k, (s = { k, ceBuy: 0, ceSell: 0, peBuy: 0, peSell: 0, ceBuyVal: 0, ceSellVal: 0, peBuyVal: 0, peSellVal: 0 }));
      s.ceBuy += cb;
      s.ceSell += cs;
      s.peBuy += pb;
      s.peSell += ps;
      s.ceBuyVal += cb * lotSize * cp;
      s.ceSellVal += cs * lotSize * cp;
      s.peBuyVal += pb * lotSize * pp;
      s.peSellVal += ps * lotSize * pp;
    }
  }
  const strikes = [...m.values()].sort((a, b) => b.k - a.k);
  const totals = strikes.reduce(
    (a, s) => ({ bull: a.bull + s.peSellVal + s.ceBuyVal, bear: a.bear + s.ceSellVal + s.peBuyVal }),
    { bull: 0, bear: 0 },
  );
  return { strikes, totals };
}

export interface BarArrows {
  bull: number; // strikes with aggressive put selling >= threshold
  bear: number; // strikes with aggressive call selling >= threshold
}

/**
 * Arrows per timeframe bucket: a strike counts when its net aggressive put (call)
 * selling within a single minute is >= `thresholdLots`, so bursts are detected the
 * same way on every timeframe. A stack of >= 3 arrows on one candle = institutional.
 */
export function flowArrows(flows: MinuteFlow[], tfMin: number, thresholdLots: number): Map<number, BarArrows> {
  const buckets = new Map<number, { bull: Set<number>; bear: Set<number> }>();
  for (const f of flows) {
    for (const [k, cb, cs, pb, ps] of f.rows) {
      const bull = ps - pb >= thresholdLots;
      const bear = cs - cb >= thresholdLots;
      if (!bull && !bear) continue;
      const t = bucketStart(f.t, tfMin);
      let b = buckets.get(t);
      if (!b) buckets.set(t, (b = { bull: new Set(), bear: new Set() }));
      if (bull) b.bull.add(k);
      if (bear) b.bear.add(k);
    }
  }
  const out = new Map<number, BarArrows>();
  for (const [t, b] of buckets) out.set(t, { bull: b.bull.size, bear: b.bear.size });
  return out;
}

/** Net bullish / bearish ₹ flow per bucket (Series mode). */
export function flowSeries(flows: MinuteFlow[], tfMin: number, lotSize: number): { t: number; bull: number; bear: number }[] {
  const m = new Map<number, { t: number; bull: number; bear: number }>();
  for (const f of flows) {
    const t = bucketStart(f.t, tfMin);
    let e = m.get(t);
    if (!e) m.set(t, (e = { t, bull: 0, bear: 0 }));
    for (const [, cb, cs, pb, ps, cp, pp] of f.rows) {
      e.bull += (ps * pp + cb * cp) * lotSize;
      e.bear += (cs * cp + pb * pp) * lotSize;
    }
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

export function fmtCr(rupees: number): string {
  const cr = rupees / 1e7;
  if (Math.abs(cr) >= 100) return `${cr.toFixed(0)}Cr`;
  if (Math.abs(cr) >= 1) return `${cr.toFixed(1)}Cr`;
  return `${(rupees / 1e5).toFixed(1)}L`;
}
