/** Black-Scholes pricing used by the simulator and the client (synthetic future, HUD). */

export const RISK_FREE = 0.065;
const YEAR_MS = 365 * 86_400_000;

function ncdf(x: number): number {
  // Abramowitz-Stegun 7.1.26 via erf
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export function yearsTo(expiryCloseMs: number, nowMs: number): number {
  return Math.max(expiryCloseMs - nowMs, 0) / YEAR_MS;
}

export function bsPrice(S: number, K: number, T: number, iv: number, type: "CE" | "PE", r = RISK_FREE): number {
  if (T <= 1e-7 || iv <= 0) return Math.max(type === "CE" ? S - K : K - S, 0);
  const vt = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / vt;
  const d2 = d1 - vt;
  const df = Math.exp(-r * T);
  return type === "CE" ? S * ncdf(d1) - K * df * ncdf(d2) : K * df * ncdf(-d2) - S * ncdf(-d1);
}

export function bsDelta(S: number, K: number, T: number, iv: number, type: "CE" | "PE", r = RISK_FREE): number {
  if (T <= 1e-7 || iv <= 0) return type === "CE" ? (S > K ? 1 : 0) : S < K ? -1 : 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  return type === "CE" ? ncdf(d1) : ncdf(d1) - 1;
}

/** Simple smile: higher IV away from ATM, a little higher on the put side. */
export function smileIv(atmIv: number, S: number, K: number): number {
  const m = Math.log(K / S) * 12;
  return Math.max(0.04, atmIv * (1 + 0.1 * m * m - 0.06 * m));
}

/** Snap an option premium to the 0.05 tick, floor 0.05. */
export function premiumTick(p: number): number {
  return Math.max(0.05, Math.round(p * 20) / 20);
}
