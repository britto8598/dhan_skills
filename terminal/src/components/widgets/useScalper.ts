"use client";
import { useMemo } from "react";
import type { Bar } from "@/lib/feed/protocol";
import { useSubs, useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { aggregate } from "@/lib/data/aggregate";
import { optionRoot, rootOf, getInstrument, displayName } from "@/lib/sim/instruments";
import { computeHud, computeLevels, planDays, type DayLevels, type HudData, type ScalperConfig } from "@/lib/analytics/scalper";
import type { HLevel, LineSeries, OptionSeries } from "../chart/PriceChartEngine";
import { C } from "../chart/theme";

export interface ScalperOut {
  active: boolean;
  mismatch: string | null;
  levels: HLevel[];
  series: LineSeries[];
  options: OptionSeries[];
  hud: HudData | null;
  dayLevels: DayLevels | null;
}

const EMPTY: ScalperOut = { active: false, mismatch: null, levels: [], series: [], options: [], hud: null, dayLevels: null };

/**
 * Scalper overlays for a chart: synthetic future, BEP levels, R/S ranges, HUD
 * data and optional option candles. Levels are in index (spot) terms; on a
 * futures chart they are shifted by the live basis.
 */
export function useScalper(enabled: boolean, chartSymbol: string, cfg: ScalperConfig, tfMin: number, rangeDays: number): ScalperOut {
  const chartRoot = rootOf(chartSymbol);
  const r = optionRoot(cfg.root);
  const on = enabled && !!r && chartRoot === cfg.root;
  const indexSym = r?.index ?? "NIFTY";
  const days = Math.max(rangeDays, cfg.daysToShow + 1);
  const idxV = useTopic(on ? `bars:${indexSym}` : null, 1000);
  const indexBars = on ? market.getBars(indexSym) : [];
  const plans = useMemo(() => (on ? planDays(indexBars, cfg) : []), [on, idxV, cfg]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = plans[plans.length - 1];
  const optSyms = useMemo(() => {
    const s = new Set<string>();
    for (const p of plans) {
      s.add(p.ce);
      s.add(p.pe);
    }
    if (today) {
      if (cfg.ceItm) s.add(today.ceItm);
      if (cfg.peItm) s.add(today.peItm);
    }
    return [...s];
  }, [plans, today, cfg.ceItm, cfg.peItm]);
  useSubs(on ? [{ kind: "bars", symbol: indexSym, days }, ...optSyms.map((symbol) => ({ kind: "bars" as const, symbol, days }))] : []);
  // re-render at most every 750ms for option updates
  const optV = useTopic(on && today ? `bars:${today.ce}` : null, 750);
  const optV2 = useTopic(on && today ? `bars:${today.pe}` : null, 750);
  useTopic("quotes", on ? 2000 : 0);

  return useMemo(() => {
    if (!enabled) return EMPTY;
    if (!r || chartRoot !== cfg.root) return { ...EMPTY, mismatch: chartRoot && optionRoot(chartRoot) ? chartRoot : null };
    if (!plans.length) return { ...EMPTY, active: true };
    const inst = getInstrument(chartSymbol);
    let shift = 0;
    if (inst?.kind === "FUT") {
      const fq = market.quotes.get(chartSymbol);
      const iq = market.quotes.get(indexSym);
      if (fq && iq) shift = fq.ltp - iq.ltp;
    }
    const isOption = inst?.kind === "OPT";
    const levels: HLevel[] = [];
    const series: LineSeries[] = [];
    let lastLv: DayLevels | null = null;
    const synthPts: { t: number; v: number }[] = [];
    for (const p of plans) {
      const ce = market.getBars(p.ce);
      const pe = market.getBars(p.pe);
      const lv = computeLevels(p, ce, pe, cfg);
      lastLv = lv;
      const add = (price: number | null, color: string, label: string, dash?: number[]) => {
        if (price === null || isOption) return;
        levels.push({ price: price + shift, color, label, dash, t1: p.open, t2: p.end - 60_000 });
      };
      add(p.strike, "rgba(148,163,184,0.6)", `K ${p.strike}`, [2, 4]);
      if (cfg.showBepPrev) {
        add(lv.bepPrevUp, C.purple, "BEP PC ▲", [6, 3]);
        add(lv.bepPrevDn, C.purple, "BEP PC ▼", [6, 3]);
      }
      if (cfg.showBepAnchor) {
        add(lv.bepAnchorUp, C.cyan, `BEP ${cfg.anchor} ▲`);
        add(lv.bepAnchorDn, C.cyan, `BEP ${cfg.anchor} ▼`);
      }
      if (cfg.showRanges) {
        add(lv.r1, "#4ade80", "R1", [3, 3]);
        add(lv.r2, "#16a34a", "R2", [3, 3]);
        add(lv.s1, "#f87171", "S1", [3, 3]);
        add(lv.s2, "#dc2626", "S2", [3, 3]);
      }
      if (cfg.showSynthetic && !isOption) for (const pt of lv.synthetic) synthPts.push({ t: pt.t, v: pt.v + shift });
    }
    if (synthPts.length) series.push({ label: "SYN", color: C.yellow, points: synthPts, width: 1.4 });
    const options: OptionSeries[] = [];
    if (today) {
      const agg = (sym: string): Bar[] => aggregate(sym, market.getBars(sym), tfMin);
      if (cfg.ceAtm) options.push({ label: displayName(today.ce), color: "#34d399", bars: agg(today.ce) });
      if (cfg.peAtm) options.push({ label: displayName(today.pe), color: "#f87171", bars: agg(today.pe) });
      if (cfg.ceItm) options.push({ label: displayName(today.ceItm), color: "#a3e635", bars: agg(today.ceItm) });
      if (cfg.peItm) options.push({ label: displayName(today.peItm), color: "#fb923c", bars: agg(today.peItm) });
    }
    const hud = lastLv && today ? computeHud(lastLv, market.getBars(today.ce), market.getBars(today.pe), cfg) : null;
    return { active: true, mismatch: null, levels, series, options, hud, dayLevels: lastLv };
  }, [enabled, r, chartRoot, cfg, plans, today, chartSymbol, indexSym, tfMin, optV, optV2]); // eslint-disable-line react-hooks/exhaustive-deps
}
