export const C = {
  bg: "#0a0d12",
  panel: "#0f131a",
  grid: "#161c25",
  gridStrong: "#1f2733",
  axis: "#8b95a5",
  text: "#c9d1d9",
  muted: "#6b7686",
  dim: "#4b5563",
  up: "#22c55e",
  down: "#ef4444",
  upDim: "rgba(34,197,94,0.35)",
  downDim: "rgba(239,68,68,0.35)",
  accent: "#3b82f6",
  yellow: "#eab308",
  orange: "#f97316",
  purple: "#a855f7",
  cyan: "#06b6d4",
  pink: "#ec4899",
  crosshair: "rgba(148,163,184,0.55)",
  vwap: "#f0b429",
  poc: "#facc15",
  va: "rgba(59,130,246,0.14)",
  mark: "#f97316",
  font: '11px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSmall: '10px ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

export const CHANNEL_COLORS: Record<string, string> = {
  red: "#ef4444",
  blue: "#3b82f6",
  yellow: "#eab308",
  none: "#4b5563",
};

export function fmtNum(v: number, digits = 0): string {
  const a = Math.abs(v);
  if (a >= 1e7) return `${(v / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${(v / 1e5).toFixed(1)}L`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(digits);
}

export function fmtPrice(p: number, tick = 0.05): string {
  const d = tick >= 1 ? 0 : tick >= 0.1 ? 1 : 2;
  return p.toFixed(d);
}

/** "Nice" step for axis grid lines. */
export function niceStep(range: number, targetLines: number): number {
  const raw = range / Math.max(1, targetLines);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return m * pow;
}
