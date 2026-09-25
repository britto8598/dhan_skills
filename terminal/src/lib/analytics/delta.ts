/** Delta / volume indicators computed per (aggregated) bar. */
import type { Bar } from "../feed/protocol";
import { istMidnight } from "../sim/time";

export function cvd(bars: Bar[], resetDaily = true): number[] {
  const out: number[] = [];
  let acc = 0;
  let day = -1;
  for (const b of bars) {
    const d = istMidnight(b.t);
    if (resetDaily && d !== day) {
      acc = 0;
      day = d;
    }
    acc += b.d;
    out.push(acc);
  }
  return out;
}

export interface VwapPoint {
  vwap: number;
  up1: number;
  dn1: number;
  up2: number;
  dn2: number;
}

/** Session VWAP with volume-weighted SD bands, reset each day. */
export function vwap(bars: Bar[]): (VwapPoint | null)[] {
  const out: (VwapPoint | null)[] = [];
  let pv = 0;
  let p2v = 0;
  let v = 0;
  let day = -1;
  for (const b of bars) {
    const d = istMidnight(b.t);
    if (d !== day) {
      pv = p2v = v = 0;
      day = d;
    }
    const tp = (b.h + b.l + b.c) / 3;
    const w = b.v || 1;
    pv += tp * w;
    p2v += tp * tp * w;
    v += w;
    const m = pv / v;
    const sd = Math.sqrt(Math.max(p2v / v - m * m, 0));
    out.push({ vwap: m, up1: m + sd, dn1: m - sd, up2: m + 2 * sd, dn2: m - 2 * sd });
  }
  return out;
}

/**
 * Delta divergence: +1 = bullish (red/down bar but net delta >= +threshold),
 * -1 = bearish (green/up bar but delta <= -threshold). Threshold in lots.
 */
export function deltaDivergence(bars: Bar[], thresholdLots: number, lotSize: number): Int8Array {
  const out = new Int8Array(bars.length);
  const th = thresholdLots * lotSize;
  bars.forEach((b, i) => {
    if (b.c > b.o && b.d <= -th) out[i] = -1;
    else if (b.c < b.o && b.d >= th) out[i] = 1;
  });
  return out;
}

/**
 * "Total Bell" aggregated volume: per-bar volume smoothed with a Gaussian kernel
 * (bell curve) so volume climaxes stand out from single-bar noise.
 */
export function bellVolume(bars: Bar[], window = 9): number[] {
  const sigma = Math.max(1, window / 3);
  const half = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  for (let k = -half; k <= half; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const out: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    let s = 0;
    let w = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= bars.length || j > i + 0) continue; // causal: no look-ahead
      s += bars[j].v * kernel[k + half];
      w += kernel[k + half];
    }
    out[i] = w ? s / w : 0;
  }
  return out;
}

/**
 * Market activity intensity 0..100: prints per minute and volume per minute
 * relative to the trailing `lookback` bars (z-score mapped to 0..100).
 */
export function activityIntensity(bars: Bar[], tfMin: number, lookback = 30): number[] {
  const act = bars.map((b) => (b.n + b.v / 1e5) / Math.max(1, tfMin));
  const out: number[] = [];
  for (let i = 0; i < act.length; i++) {
    const s = Math.max(0, i - lookback);
    const win = act.slice(s, i);
    if (win.length < 3) {
      out.push(50);
      continue;
    }
    const m = win.reduce((a, b) => a + b, 0) / win.length;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - m) ** 2, 0) / win.length) || 1;
    out.push(Math.max(0, Math.min(100, 50 + 18 * ((act[i] - m) / sd))));
  }
  return out;
}
