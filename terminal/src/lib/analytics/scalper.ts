/**
 * Options scalper overlays: synthetic future, straddle break-even levels, range
 * targets and the HUD table.
 *
 *   Synthetic Future = K + CE(K) - PE(K)
 *   BEP (prev close)  = K ± (CE_prevClose + PE_prevClose)
 *   BEP (anchor)      = K ± (CE + PE at the anchor time, e.g. 09:20)
 *   R1/R2 (S1/S2)     = upper (lower) anchor BEP ± 1× / 2× base offset
 */
import type { Bar } from "../feed/protocol";
import { atmStrike, expiriesFor, optionSymbol, optionRoot } from "../sim/instruments";
import { MIN_MS, istMidnight, parseHm, sessionOpen } from "../sim/time";

export interface ScalperConfig {
  root: string;
  expiry: string; // YYMMDD, "" = nearest
  baseStrike: number; // 0 = ATM at the anchor time
  offset: number; // base offset points for R/S levels
  slPoints: number;
  anchor: string; // "09:15" | "09:20" | "HH:MM"
  daysToShow: number;
  showSynthetic: boolean;
  showBepPrev: boolean;
  showBepAnchor: boolean;
  showRanges: boolean;
  showHud: boolean;
  ceAtm: boolean;
  peAtm: boolean;
  ceItm: boolean;
  peItm: boolean;
  optionMode: "pane" | "overlay";
}

export function defaultScalper(root = "NIFTY"): ScalperConfig {
  const step = optionRoot(root)?.strikeStep ?? 50;
  return {
    root,
    expiry: "",
    baseStrike: 0,
    offset: step,
    slPoints: 20,
    anchor: "09:20",
    daysToShow: 1,
    showSynthetic: true,
    showBepPrev: true,
    showBepAnchor: true,
    showRanges: true,
    showHud: true,
    ceAtm: false,
    peAtm: false,
    ceItm: false,
    peItm: false,
    optionMode: "pane",
  };
}

export interface DayPlan {
  day: number;
  open: number;
  end: number;
  anchorT: number;
  strike: number;
  expiry: string;
  ce: string;
  pe: string;
  ceItm: string;
  peItm: string;
}

/** Strike/expiry per session for the last `cfg.daysToShow` sessions in `indexBars` (1-minute). */
export function planDays(indexBars: Bar[], cfg: ScalperConfig): DayPlan[] {
  const r = optionRoot(cfg.root);
  if (!r || !indexBars.length) return [];
  const days: number[] = [];
  for (const b of indexBars) {
    const d = istMidnight(b.t);
    if (days[days.length - 1] !== d) days.push(d);
  }
  const anchorMin = parseHm(cfg.anchor);
  return days.slice(-Math.max(1, cfg.daysToShow)).map((day, i, arr) => {
    const open = sessionOpen(day + 12 * 3600_000);
    const anchorT = day + anchorMin * MIN_MS;
    const anchorBar = indexBars.find((b) => b.t >= anchorT && b.t < open + 375 * MIN_MS) ?? indexBars.find((b) => b.t >= open);
    const spot = anchorBar ? anchorBar.o : indexBars[indexBars.length - 1].c;
    const strike = cfg.baseStrike > 0 ? cfg.baseStrike : atmStrike(cfg.root, spot);
    const expiry = /^\d{6}$/.test(cfg.expiry) ? cfg.expiry : expiriesFor(cfg.root, anchorT, 1)[0];
    const end = i + 1 < arr.length ? sessionOpen(arr[i + 1] + 12 * 3600_000) : open + 375 * MIN_MS;
    return {
      day,
      open,
      end,
      anchorT,
      strike,
      expiry,
      ce: optionSymbol(cfg.root, expiry, strike, "CE"),
      pe: optionSymbol(cfg.root, expiry, strike, "PE"),
      ceItm: optionSymbol(cfg.root, expiry, strike - r.strikeStep, "CE"),
      peItm: optionSymbol(cfg.root, expiry, strike + r.strikeStep, "PE"),
    };
  });
}

export interface DayLevels {
  plan: DayPlan;
  cePc: number | null;
  pePc: number | null;
  ceAnchor: number | null;
  peAnchor: number | null;
  bepPrevUp: number | null;
  bepPrevDn: number | null;
  bepAnchorUp: number | null;
  bepAnchorDn: number | null;
  r1: number | null;
  r2: number | null;
  s1: number | null;
  s2: number | null;
  synthetic: { t: number; v: number }[];
}

function prevClose(bars: Bar[], before: number): number | null {
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t < before) return bars[i].c;
  return null;
}

function valueAt(bars: Bar[], t: number, end: number): number | null {
  const b = bars.find((x) => x.t >= t && x.t < end);
  return b ? b.o : null;
}

export function computeLevels(plan: DayPlan, ce: Bar[], pe: Bar[], cfg: ScalperConfig): DayLevels {
  const K = plan.strike;
  const cePc = prevClose(ce, plan.open);
  const pePc = prevClose(pe, plan.open);
  const ceA = valueAt(ce, plan.anchorT, plan.end);
  const peA = valueAt(pe, plan.anchorT, plan.end);
  const prevS = cePc !== null && pePc !== null ? cePc + pePc : null;
  const anchorS = ceA !== null && peA !== null ? ceA + peA : null;
  const peMap = new Map(pe.map((b) => [b.t, b]));
  const synthetic: { t: number; v: number }[] = [];
  for (const b of ce) {
    if (b.t < plan.open || b.t >= plan.end) continue;
    const p = peMap.get(b.t);
    if (p) synthetic.push({ t: b.t, v: K + b.c - p.c });
  }
  const up = anchorS !== null ? K + anchorS : null;
  const dn = anchorS !== null ? K - anchorS : null;
  return {
    plan,
    cePc,
    pePc,
    ceAnchor: ceA,
    peAnchor: peA,
    bepPrevUp: prevS !== null ? K + prevS : null,
    bepPrevDn: prevS !== null ? K - prevS : null,
    bepAnchorUp: up,
    bepAnchorDn: dn,
    r1: up !== null ? up + cfg.offset : null,
    r2: up !== null ? up + 2 * cfg.offset : null,
    s1: dn !== null ? dn - cfg.offset : null,
    s2: dn !== null ? dn - 2 * cfg.offset : null,
    synthetic,
  };
}

export interface HudLeg {
  pc: number | null;
  ltp: number | null;
  bep: number | null;
  chg: number | null;
  sl: number | null;
}

export interface HudData {
  strike: number;
  expiry: string;
  ce: HudLeg;
  pe: HudLeg;
  addedPremium: number | null;
  straddle: number | null;
  anchorStraddle: number | null;
  synthetic: number | null;
}

export function computeHud(lv: DayLevels, ce: Bar[], pe: Bar[], cfg: ScalperConfig): HudData {
  const K = lv.plan.strike;
  const ceL = ce.length ? ce[ce.length - 1].c : null;
  const peL = pe.length ? pe[pe.length - 1].c : null;
  const leg = (pc: number | null, ltp: number | null, type: "CE" | "PE"): HudLeg => ({
    pc,
    ltp,
    bep: ltp === null ? null : type === "CE" ? K + ltp : K - ltp,
    chg: pc !== null && ltp !== null ? ltp - pc : null,
    sl: ltp === null ? null : Math.max(0.05, ltp - cfg.slPoints),
  });
  const ceLeg = leg(lv.cePc, ceL, "CE");
  const peLeg = leg(lv.pePc, peL, "PE");
  return {
    strike: K,
    expiry: lv.plan.expiry,
    ce: ceLeg,
    pe: peLeg,
    addedPremium: ceLeg.chg !== null && peLeg.chg !== null ? ceLeg.chg + peLeg.chg : null,
    straddle: ceL !== null && peL !== null ? ceL + peL : null,
    anchorStraddle: lv.ceAnchor !== null && lv.peAnchor !== null ? lv.ceAnchor + lv.peAnchor : null,
    synthetic: ceL !== null && peL !== null ? K + ceL - peL : null,
  };
}
