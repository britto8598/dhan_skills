/**
 * Canvas price chart: candlesticks and footprint (bid×ask clusters) with zoom,
 * pan, auto/manual price scale, sub-panes (volume, delta, CVD, bell volume,
 * activity intensity, option candles), bar statistics table, overlays (VWAP,
 * levels, series, flow arrows, divergence flags) and drawing tools.
 *
 * Rendering happens on requestAnimationFrame only when something changed.
 */
import type { Bar } from "@/lib/feed/protocol";
import type { AggBar } from "@/lib/data/aggregate";
import type { Instrument } from "@/lib/sim/instruments";
import type { Drawing } from "@/lib/state/workspace";
import { fmtDate, fmtTime, istMidnight, MIN_MS } from "@/lib/sim/time";
import { autoRowSize, footprintRows, pocRow, stackedZones, tickRowSize, type ImbalanceMode } from "@/lib/analytics/footprint";
import { activityIntensity, bellVolume, cvd, deltaDivergence, vwap, type VwapPoint } from "@/lib/analytics/delta";
import { volumeProfile } from "@/lib/analytics/profile";
import type { BarArrows } from "@/lib/analytics/moneyflow";
import { C, fmtNum, fmtPrice, niceStep } from "./theme";

export type Tool = "none" | "trend" | "hline" | "vprofile" | "mark";

export interface HLevel {
  price: number;
  color: string;
  label: string;
  dash?: number[];
  t1?: number;
  t2?: number;
}

export interface LineSeries {
  label: string;
  color: string;
  points: { t: number; v: number }[];
  width?: number;
}

export interface OptionSeries {
  label: string;
  color: string;
  bars: Bar[]; // aggregated to the chart timeframe
}

export interface ChartSettings {
  mode: "candles" | "footprint";
  volume: boolean;
  deltaPane: boolean;
  cvd: boolean;
  bell: boolean;
  intensity: boolean;
  stats: boolean;
  vwap: boolean;
  divergence: boolean;
  divThreshold: number;
  fpTicks: string; // "auto" | "10" | "20" | "40" | "50" | "100"
  fpRatio: number;
  fpMode: ImbalanceMode;
  fpDisplay: "bidask" | "delta" | "volume";
  units: "lots" | "qty";
  optionMode: "pane" | "overlay";
}

export interface ChartInputs {
  bars: AggBar[];
  inst: Instrument;
  tfMin: number;
  settings: ChartSettings;
  levels: HLevel[];
  series: LineSeries[];
  options: OptionSeries[];
  arrows: Map<number, BarArrows> | null;
  drawings: Drawing[];
  markT: number | null;
  loading: boolean;
}

export interface ChartCallbacks {
  onBarClick?: (t: number) => void;
  onCrosshair?: (t: number | null) => void;
  onAddDrawing?: (d: Omit<Drawing, "id" | "color">) => void;
  onUpdateDrawing?: (id: string, p: Partial<Drawing>) => void;
  onRemoveDrawing?: (id: string) => void;
  onToolDone?: () => void;
}

interface Pane {
  key: string;
  label: string;
  top: number;
  h: number;
}

const AXIS_W = 66;
const TIME_H = 20;
const STAT_ROW = 13;
const STAT_ROWS = ["Delta", "Min Δ", "Max Δ", "Cum Δ", "Volume"];

type Drag =
  | { kind: "pan"; x: number; y: number; offset: number; min: number; max: number; manual: boolean }
  | { kind: "scale"; y: number; min: number; max: number }
  | { kind: "draw"; tool: Tool; t1: number; p1: number; t2: number; p2: number }
  | { kind: "move"; id: string; x: number; y: number; orig: Drawing };

export class PriceChartEngine {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private inp: ChartInputs | null = null;
  private barSpacing = 9;
  private offset = 4; // bars of empty space right of the last bar
  private manualScale: { min: number; max: number } | null = null;
  private tool: Tool = "none";
  private mouse: { x: number; y: number } | null = null;
  private extCross: number | null = null;
  private drag: Drag | null = null;
  private downAt: { x: number; y: number } | null = null;
  private selected: string | null = null;
  private dirty = true;
  private raf = 0;
  private destroyed = false;
  private lastMode: string | null = null;
  // per-frame computed
  private panes: Pane[] = [];
  private mainTop = 0;
  private mainH = 0;
  private plotW = 0;
  private yMin = 0;
  private yMax = 1;
  private cache: { bars: AggBar[] | null; cvd: number[]; vwap: (VwapPoint | null)[]; bell: number[]; intensity: number[]; div: Int8Array } = {
    bars: null,
    cvd: [],
    vwap: [],
    bell: [],
    intensity: [],
    div: new Int8Array(0),
  };
  private derivedKey = "";

  constructor(private canvas: HTMLCanvasElement, private cb: ChartCallbacks = {}) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    canvas.addEventListener("mousedown", this.onDown);
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
    canvas.addEventListener("mouseleave", this.onLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDbl);
    canvas.addEventListener("keydown", this.onKey);
    canvas.tabIndex = 0;
    this.loop();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener("mousedown", this.onDown);
    window.removeEventListener("mousemove", this.onMove);
    window.removeEventListener("mouseup", this.onUp);
    this.canvas.removeEventListener("mouseleave", this.onLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
    this.canvas.removeEventListener("dblclick", this.onDbl);
    this.canvas.removeEventListener("keydown", this.onKey);
  }

  setCallbacks(cb: ChartCallbacks): void {
    this.cb = cb;
  }

  resize(w: number, h: number, dpr: number): void {
    this.w = Math.max(10, Math.floor(w));
    this.h = Math.max(10, Math.floor(h));
    this.dpr = dpr;
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.dirty = true;
  }

  setInputs(inp: ChartInputs): void {
    const modeKey = `${inp.settings.mode}|${inp.inst.symbol}|${inp.tfMin}`;
    if (modeKey !== this.lastMode) {
      const prevMode = this.lastMode?.split("|")[0];
      if (prevMode !== inp.settings.mode) this.barSpacing = inp.settings.mode === "footprint" ? 84 : 9;
      this.offset = inp.settings.mode === "footprint" ? 0.6 : 4;
      this.manualScale = null;
      this.lastMode = modeKey;
    }
    this.inp = inp;
    this.dirty = true;
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.canvas.style.cursor = t === "none" ? "crosshair" : "copy";
    this.dirty = true;
  }

  setExternalCrosshair(t: number | null): void {
    this.extCross = t;
    this.dirty = true;
  }

  resetView(): void {
    this.offset = this.inp?.settings.mode === "footprint" ? 0.6 : 4;
    this.manualScale = null;
    this.barSpacing = this.inp?.settings.mode === "footprint" ? 84 : 9;
    this.dirty = true;
  }

  private loop = (): void => {
    if (this.destroyed) return;
    if (this.dirty) {
      this.dirty = false;
      try {
        this.render();
      } catch (e) {
        console.error("[chart]", e);
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  // ------------------------------------------------------------------ geometry

  private get n(): number {
    return this.inp?.bars.length ?? 0;
  }

  private xOf(i: number): number {
    return this.plotW - (this.n - 1 - i + this.offset + 0.5) * this.barSpacing;
  }

  private iOf(x: number): number {
    return this.n - 1 + this.offset + 0.5 + (x - this.plotW) / this.barSpacing;
  }

  private yOf(p: number): number {
    return this.mainTop + ((this.yMax - p) / (this.yMax - this.yMin)) * this.mainH;
  }

  private pOf(y: number): number {
    return this.yMax - ((y - this.mainTop) / this.mainH) * (this.yMax - this.yMin);
  }

  private tfMs(): number {
    return (this.inp?.tfMin ?? 1) * MIN_MS;
  }

  /** Fractional bar index for a timestamp. */
  private idxOfTime(t: number): number {
    const bars = this.inp?.bars ?? [];
    if (!bars.length) return 0;
    const tf = this.tfMs();
    if (t < bars[0].t) return (t - bars[0].t) / tf;
    const last = bars[bars.length - 1];
    if (t >= last.t) return bars.length - 1 + (t - last.t) / tf;
    let lo = 0;
    let hi = bars.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo + Math.min(0.999, (t - bars[lo].t) / tf);
  }

  private timeOfIdx(i: number): number {
    const bars = this.inp?.bars ?? [];
    if (!bars.length) return 0;
    const tf = this.tfMs();
    if (i < 0) return bars[0].t + i * tf;
    if (i >= bars.length - 1) return bars[bars.length - 1].t + (i - (bars.length - 1)) * tf;
    const k = Math.floor(i);
    return bars[k].t + (i - k) * tf;
  }

  private xOfTime(t: number): number {
    return this.xOf(this.idxOfTime(t));
  }

  private visibleRange(): [number, number] {
    const from = Math.max(0, Math.floor(this.iOf(0)) - 1);
    const to = Math.min(this.n - 1, Math.ceil(this.iOf(this.plotW)) + 1);
    return [from, to];
  }

  private unit(v: number): number {
    const inp = this.inp!;
    return inp.settings.units === "lots" ? v / Math.max(1, inp.inst.lotSize) : v;
  }

  // ------------------------------------------------------------------ derived data

  private ensureDerived(): void {
    const inp = this.inp!;
    const bars = inp.bars;
    const last = bars[bars.length - 1];
    const s = inp.settings;
    const key = `${bars.length}|${last?.t}|${last?.v}|${last?.c}|${s.divThreshold}|${inp.tfMin}`;
    if (key === this.derivedKey && this.cache.bars === bars) return;
    this.derivedKey = key;
    this.cache = {
      bars,
      cvd: cvd(bars),
      vwap: vwap(bars),
      bell: bellVolume(bars, 9),
      intensity: activityIntensity(bars, inp.tfMin),
      div: deltaDivergence(bars, s.divThreshold, inp.inst.lotSize),
    };
  }

  // ------------------------------------------------------------------ render

  private render(): void {
    const ctx = this.ctx;
    const { w, h, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    ctx.font = C.font;
    const inp = this.inp;
    if (!inp || !inp.bars.length) {
      ctx.fillStyle = C.muted;
      ctx.textAlign = "center";
      ctx.fillText(inp?.loading === false ? "No data" : "Loading…", w / 2, h / 2);
      return;
    }
    this.ensureDerived();

    const s = inp.settings;
    this.plotW = w - AXIS_W;
    const statsH = s.stats ? STAT_ROWS.length * STAT_ROW + 4 : 0;
    const paneDefs: [string, string, boolean][] = [
      ["options", "Options", inp.options.length > 0 && s.optionMode === "pane"],
      ["volume", "Volume", s.volume],
      ["delta", "Delta", s.deltaPane],
      ["cvd", "CVD", s.cvd],
      ["bell", "Bell Volume", s.bell],
      ["intensity", "Activity", s.intensity],
    ];
    const active = paneDefs.filter((p) => p[2]);
    const avail = h - TIME_H - statsH;
    let paneTotal = 0;
    const heights = active.map(([k]) => {
      const ph = k === "options" ? Math.max(60, Math.floor(avail * 0.28)) : Math.max(34, Math.min(80, Math.floor(avail * 0.14)));
      paneTotal += ph;
      return ph;
    });
    this.mainTop = 0;
    this.mainH = Math.max(60, avail - paneTotal);
    let y = this.mainH;
    this.panes = active.map(([key, label], k) => {
      const p = { key, label, top: y, h: heights[k] };
      y += heights[k];
      return p;
    });
    const timeTop = y;

    const [from, to] = this.visibleRange();
    this.computeScale(from, to);

    // clip main pane
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.mainTop, this.plotW, this.mainH);
    ctx.clip();
    this.drawGrid(from, to);
    this.drawProfiles();
    if (s.mode === "footprint") this.drawFootprint(from, to);
    else this.drawCandles(from, to);
    if (s.vwap) this.drawVwap(from, to);
    if (s.optionMode === "overlay" && inp.options.length) this.drawOptionOverlay(from, to);
    this.drawSeries();
    this.drawLevels();
    if (s.divergence) this.drawDivergence(from, to);
    if (inp.arrows) this.drawArrows(from, to);
    this.drawMark();
    this.drawDrawings();
    ctx.restore();

    for (const p of this.panes) this.drawPane(p, from, to);
    if (s.stats) this.drawStats(timeTop, from, to);
    this.drawTimeAxis(s.stats ? timeTop + statsH : timeTop, from, to);
    this.drawPriceAxis();
    this.drawCrosshair();
    this.drawLegend();
  }

  private computeScale(from: number, to: number): void {
    const inp = this.inp!;
    if (this.manualScale) {
      this.yMin = this.manualScale.min;
      this.yMax = this.manualScale.max;
      return;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i <= to; i++) {
      const b = inp.bars[i];
      if (!b) continue;
      if (b.l < lo) lo = b.l;
      if (b.h > hi) hi = b.h;
    }
    if (!Number.isFinite(lo)) {
      const b = inp.bars[inp.bars.length - 1];
      lo = b.l;
      hi = b.h;
    }
    for (const s of inp.series) {
      for (const pt of s.points) {
        const i = this.idxOfTime(pt.t);
        if (i >= from && i <= to + 1) {
          if (pt.v < lo) lo = pt.v;
          if (pt.v > hi) hi = pt.v;
        }
      }
    }
    const pad = Math.max((hi - lo) * 0.08, inp.inst.tickSize * 4);
    this.yMin = lo - pad;
    this.yMax = hi + pad;
  }

  private drawGrid(from: number, to: number): void {
    const ctx = this.ctx;
    const step = niceStep(this.yMax - this.yMin, Math.max(3, this.mainH / 55));
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let p = Math.ceil(this.yMin / step) * step; p <= this.yMax; p += step) {
      const y = Math.round(this.yOf(p)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotW, y);
    }
    ctx.stroke();
    // day separators
    const bars = this.inp!.bars;
    ctx.strokeStyle = C.gridStrong;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    for (let i = Math.max(1, from); i <= to; i++) {
      if (istMidnight(bars[i].t) !== istMidnight(bars[i - 1].t)) {
        const x = Math.round(this.xOf(i) - this.barSpacing / 2) + 0.5;
        ctx.moveTo(x, this.mainTop);
        ctx.lineTo(x, this.mainTop + this.mainH);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawCandles(from: number, to: number): void {
    const ctx = this.ctx;
    const bars = this.inp!.bars;
    const bw = Math.max(1, Math.floor(this.barSpacing * 0.7));
    for (let i = from; i <= to; i++) {
      const b = bars[i];
      const x = Math.round(this.xOf(i));
      const up = b.c >= b.o;
      ctx.fillStyle = ctx.strokeStyle = up ? C.up : C.down;
      const yh = this.yOf(b.h);
      const yl = this.yOf(b.l);
      ctx.fillRect(x, Math.round(yh), 1, Math.max(1, Math.round(yl - yh)));
      const yo = this.yOf(b.o);
      const yc = this.yOf(b.c);
      const top = Math.round(Math.min(yo, yc));
      const bh = Math.max(1, Math.round(Math.abs(yc - yo)));
      if (bw >= 3) ctx.fillRect(x - Math.floor(bw / 2), top, bw, bh);
    }
  }

  private rowSize(): number {
    const inp = this.inp!;
    const s = inp.settings;
    const pxPerPrice = this.mainH / (this.yMax - this.yMin);
    if (s.fpTicks === "auto") return autoRowSize(pxPerPrice, inp.inst.fpRow, 15);
    return tickRowSize(Number(s.fpTicks) || 10, inp.inst.tickSize, inp.inst.fpRow);
  }

  private drawFootprint(from: number, to: number): void {
    const ctx = this.ctx;
    const inp = this.inp!;
    const s = inp.settings;
    const bars = inp.bars;
    const size = this.rowSize();
    const rowH = (size / (this.yMax - this.yMin)) * this.mainH;
    const bw = this.barSpacing * 0.9;
    const textMode = rowH >= 9 && bw >= 52;
    const fontPx = Math.max(8, Math.min(12, Math.floor(rowH * 0.72)));
    ctx.textBaseline = "middle";
    for (let i = from; i <= to; i++) {
      const b = bars[i];
      if (!b.cells.length) continue;
      const rows = footprintRows(b, size, s.fpRatio, s.fpMode);
      let maxV = 1;
      for (const r of rows) maxV = Math.max(maxV, r.bid + r.ask);
      const xc = this.xOf(i);
      const x0 = xc - bw / 2 + 4;
      const cw = bw - 5;
      // OHLC strip
      const up = b.c >= b.o;
      ctx.fillStyle = up ? C.up : C.down;
      ctx.fillRect(Math.round(xc - bw / 2), Math.round(this.yOf(b.h)), 1, Math.max(1, Math.round(this.yOf(b.l) - this.yOf(b.h))));
      const yo = this.yOf(b.o);
      const yc = this.yOf(b.c);
      ctx.fillRect(Math.round(xc - bw / 2) - 1, Math.round(Math.min(yo, yc)), 3, Math.max(1, Math.round(Math.abs(yc - yo))));
      const poc = pocRow(rows);
      for (const r of rows) {
        const yTop = this.yOf(r.p + size);
        const hh = Math.max(1, this.yOf(r.p) - yTop - (textMode ? 1 : 0));
        const vol = r.bid + r.ask;
        const a = 0.12 + 0.55 * (vol / maxV);
        const delta = r.ask - r.bid;
        if (textMode) {
          ctx.fillStyle = `rgba(59,130,246,${(a * 0.55).toFixed(3)})`;
          ctx.fillRect(x0, yTop, cw, hh);
          if (r.buyImb) {
            ctx.fillStyle = "rgba(34,197,94,0.28)";
            ctx.fillRect(x0 + cw / 2, yTop, cw / 2, hh);
          }
          if (r.sellImb) {
            ctx.fillStyle = "rgba(239,68,68,0.28)";
            ctx.fillRect(x0, yTop, cw / 2, hh);
          }
          const ym = yTop + hh / 2;
          const bidTxt = fmtNum(this.unit(r.bid));
          const askTxt = fmtNum(this.unit(r.ask));
          if (s.fpDisplay === "bidask") {
            ctx.font = `${r.sellImb ? "bold " : ""}${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
            ctx.fillStyle = r.sellImb ? "#ff6b6b" : "#cbd5e1";
            ctx.textAlign = "right";
            ctx.fillText(bidTxt, x0 + cw / 2 - 4, ym);
            ctx.font = `${r.buyImb ? "bold " : ""}${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
            ctx.fillStyle = r.buyImb ? "#4ade80" : "#cbd5e1";
            ctx.textAlign = "left";
            ctx.fillText(askTxt, x0 + cw / 2 + 4, ym);
            ctx.fillStyle = C.muted;
            ctx.textAlign = "center";
            ctx.font = `${Math.max(7, fontPx - 3)}px ui-monospace, monospace`;
            ctx.fillText("x", x0 + cw / 2, ym);
          } else {
            const v = s.fpDisplay === "delta" ? delta : vol;
            ctx.font = `${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
            ctx.fillStyle = s.fpDisplay === "delta" ? (delta >= 0 ? "#4ade80" : "#ff6b6b") : "#cbd5e1";
            ctx.textAlign = "center";
            ctx.fillText(fmtNum(this.unit(v)), x0 + cw / 2, ym);
          }
        } else {
          ctx.fillStyle = delta >= 0 ? `rgba(34,197,94,${a.toFixed(3)})` : `rgba(239,68,68,${a.toFixed(3)})`;
          ctx.fillRect(x0, yTop, cw, hh);
        }
        if (poc && r === poc) {
          ctx.strokeStyle = C.poc;
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(x0) + 0.5, Math.round(yTop) + 0.5, Math.round(cw) - 1, Math.max(1, Math.round(hh) - 1));
        }
      }
      // stacked imbalance markers on the right edge of the bar
      for (const [lo, hi] of stackedZones(rows, size, "buy")) {
        ctx.fillStyle = C.up;
        ctx.fillRect(x0 + cw + 1, this.yOf(hi + size), 2, this.yOf(lo) - this.yOf(hi + size));
      }
      for (const [lo, hi] of stackedZones(rows, size, "sell")) {
        ctx.fillStyle = C.down;
        ctx.fillRect(x0 + cw + 1, this.yOf(hi + size), 2, this.yOf(lo) - this.yOf(hi + size));
      }
    }
    ctx.textBaseline = "alphabetic";
    ctx.font = C.font;
  }

  private drawVwap(from: number, to: number): void {
    const v = this.cache.vwap;
    const bars = this.inp!.bars;
    const line = (key: keyof VwapPoint, color: string, dash: number[] = []) => {
      const ctx = this.ctx;
      ctx.strokeStyle = color;
      ctx.lineWidth = key === "vwap" ? 1.4 : 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      let started = false;
      for (let i = from; i <= to; i++) {
        const p = v[i];
        if (!p || (i > 0 && istMidnight(bars[i].t) !== istMidnight(bars[i - 1].t))) {
          started = false;
          if (!p) continue;
        }
        const x = this.xOf(i);
        const y = this.yOf(p[key]);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    };
    line("up2", "rgba(240,180,41,0.25)", [2, 3]);
    line("dn2", "rgba(240,180,41,0.25)", [2, 3]);
    line("up1", "rgba(240,180,41,0.4)", [4, 3]);
    line("dn1", "rgba(240,180,41,0.4)", [4, 3]);
    line("vwap", C.vwap);
  }

  private drawSeries(): void {
    const ctx = this.ctx;
    for (const s of this.inp!.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width ?? 1.5;
      ctx.beginPath();
      let prevT = 0;
      s.points.forEach((pt, k) => {
        const x = this.xOfTime(pt.t);
        const y = this.yOf(pt.v);
        if (k === 0 || pt.t - prevT > 90 * MIN_MS) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        prevT = pt.t;
      });
      ctx.stroke();
      const last = s.points[s.points.length - 1];
      if (last) this.axisTag(last.v, s.color, s.label);
    }
  }

  private drawLevels(): void {
    const ctx = this.ctx;
    for (const lv of this.inp!.levels) {
      const y = Math.round(this.yOf(lv.price)) + 0.5;
      if (y < this.mainTop - 20 || y > this.mainTop + this.mainH + 20) continue;
      const x1 = lv.t1 !== undefined ? Math.max(0, this.xOfTime(lv.t1) - this.barSpacing / 2) : 0;
      const x2 = lv.t2 !== undefined ? Math.min(this.plotW, this.xOfTime(lv.t2)) : this.plotW;
      if (x2 < 0 || x1 > this.plotW) continue;
      ctx.strokeStyle = lv.color;
      ctx.lineWidth = 1;
      ctx.setLineDash(lv.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = C.fontSmall;
      ctx.fillStyle = lv.color;
      ctx.textAlign = "right";
      ctx.fillText(`${lv.label} ${fmtPrice(lv.price, this.inp!.inst.tickSize)}`, Math.min(x2, this.plotW) - 4, y - 3);
    }
    ctx.font = C.font;
  }

  private drawDivergence(from: number, to: number): void {
    const ctx = this.ctx;
    const div = this.cache.div;
    const bars = this.inp!.bars;
    for (let i = from; i <= to; i++) {
      if (!div[i]) continue;
      const b = bars[i];
      const x = this.xOf(i);
      const s = Math.max(4, Math.min(7, this.barSpacing * 0.4));
      ctx.fillStyle = div[i] > 0 ? "#34d399" : "#fb7185";
      ctx.beginPath();
      if (div[i] > 0) {
        const y = this.yOf(b.l) + 6;
        ctx.moveTo(x, y);
        ctx.lineTo(x - s, y + s * 1.4);
        ctx.lineTo(x + s, y + s * 1.4);
      } else {
        const y = this.yOf(b.h) - 6;
        ctx.moveTo(x, y);
        ctx.lineTo(x - s, y - s * 1.4);
        ctx.lineTo(x + s, y - s * 1.4);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  private drawArrows(from: number, to: number): void {
    const ctx = this.ctx;
    const inp = this.inp!;
    const div = inp.settings.divergence ? this.cache.div : null;
    for (let i = from; i <= to; i++) {
      const b = inp.bars[i];
      const a = inp.arrows!.get(b.t);
      if (!a) continue;
      const x = this.xOf(i);
      const sz = Math.max(5, Math.min(9, this.barSpacing * 0.45));
      const draw = (count: number, dir: 1 | -1) => {
        const n = Math.min(count, 6);
        const baseY = dir > 0 ? this.yOf(b.l) + (div?.[i] ? 22 : 8) : this.yOf(b.h) - (div?.[i] ? 22 : 8);
        const inst = count >= 3;
        if (inst) {
          const top = dir > 0 ? baseY - 2 : baseY - n * (sz + 2) - 2;
          ctx.fillStyle = dir > 0 ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.18)";
          ctx.strokeStyle = dir > 0 ? C.up : C.down;
          ctx.fillRect(x - sz - 3, top, sz * 2 + 6, n * (sz + 2) + 4);
          ctx.strokeRect(x - sz - 3 + 0.5, top + 0.5, sz * 2 + 5, n * (sz + 2) + 3);
          ctx.font = "bold 9px ui-monospace, monospace";
          ctx.fillStyle = dir > 0 ? C.up : C.down;
          ctx.textAlign = "center";
          ctx.fillText("INST", x, dir > 0 ? top + n * (sz + 2) + 14 : top - 4);
        }
        ctx.fillStyle = dir > 0 ? C.up : C.down;
        for (let k = 0; k < n; k++) {
          const y = dir > 0 ? baseY + k * (sz + 2) : baseY - k * (sz + 2);
          ctx.beginPath();
          if (dir > 0) {
            ctx.moveTo(x, y);
            ctx.lineTo(x - sz * 0.7, y + sz);
            ctx.lineTo(x + sz * 0.7, y + sz);
          } else {
            ctx.moveTo(x, y);
            ctx.lineTo(x - sz * 0.7, y - sz);
            ctx.lineTo(x + sz * 0.7, y - sz);
          }
          ctx.closePath();
          ctx.fill();
        }
      };
      if (a.bull) draw(a.bull, 1);
      if (a.bear) draw(a.bear, -1);
    }
    ctx.font = C.font;
  }

  private drawMark(): void {
    const t = this.inp!.markT;
    if (t === null) return;
    const ctx = this.ctx;
    const x = Math.round(this.xOfTime(t)) + 0.5;
    ctx.strokeStyle = C.mark;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(x, this.mainTop);
    ctx.lineTo(x, this.mainTop + this.mainH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = C.mark;
    ctx.font = C.fontSmall;
    ctx.textAlign = "left";
    ctx.fillText(`MARK ${fmtTime(t)}`, x + 3, this.mainTop + 12);
    ctx.font = C.font;
  }

  private drawOptionOverlay(from: number, to: number): void {
    const inp = this.inp!;
    let lo = Infinity;
    let hi = -Infinity;
    const maps = inp.options.map((s) => new Map(s.bars.map((b) => [b.t, b])));
    for (let i = from; i <= to; i++) {
      const t = inp.bars[i].t;
      for (const m of maps) {
        const b = m.get(t);
        if (b) {
          lo = Math.min(lo, b.l);
          hi = Math.max(hi, b.h);
        }
      }
    }
    if (!Number.isFinite(lo)) return;
    const pad = (hi - lo) * 0.08 || 1;
    this.drawOptionCandles(from, to, maps, lo - pad, hi + pad, this.mainTop, this.mainH, 0.55, true);
  }

  private drawOptionCandles(from: number, to: number, maps: Map<number, Bar>[], lo: number, hi: number, top: number, hgt: number, alpha: number, leftAxis: boolean): void {
    const ctx = this.ctx;
    const inp = this.inp!;
    const yOf = (p: number) => top + ((hi - p) / (hi - lo)) * hgt;
    const k = maps.length;
    const slot = this.barSpacing / Math.max(1, k);
    maps.forEach((m, si) => {
      const color = inp.options[si].color;
      ctx.globalAlpha = alpha;
      for (let i = from; i <= to; i++) {
        const b = m.get(inp.bars[i].t);
        if (!b) continue;
        const x = Math.round(this.xOf(i) - this.barSpacing / 2 + slot * (si + 0.5));
        const up = b.c >= b.o;
        ctx.fillStyle = color;
        ctx.fillRect(x, Math.round(yOf(b.h)), 1, Math.max(1, Math.round(yOf(b.l) - yOf(b.h))));
        const bw = Math.max(1, Math.floor(slot * 0.7));
        const y1 = yOf(Math.max(b.o, b.c));
        const bh = Math.max(1, Math.abs(yOf(b.o) - yOf(b.c)));
        if (up) {
          ctx.strokeStyle = color;
          ctx.strokeRect(x - Math.floor(bw / 2) + 0.5, Math.round(y1) + 0.5, Math.max(1, bw - 1), Math.max(1, Math.round(bh) - 1));
        } else ctx.fillRect(x - Math.floor(bw / 2), Math.round(y1), bw, Math.round(bh));
      }
      ctx.globalAlpha = 1;
      const lastBar = inp.options[si].bars[inp.options[si].bars.length - 1];
      ctx.font = C.fontSmall;
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(`${inp.options[si].label} ${lastBar ? lastBar.c.toFixed(2) : ""}`, 4, top + 12 + si * 12);
    });
    if (leftAxis) {
      ctx.fillStyle = C.muted;
      ctx.font = C.fontSmall;
      ctx.textAlign = "left";
      const step = niceStep(hi - lo, 5);
      for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) ctx.fillText(p.toFixed(1), 4, yOf(p) + 3);
    }
    ctx.font = C.font;
  }

  private drawProfiles(): void {
    const inp = this.inp!;
    const ctx = this.ctx;
    for (const d of inp.drawings) {
      if (d.kind !== "vprofile" || d.t2 === undefined) continue;
      const t1 = Math.min(d.t1, d.t2);
      const t2 = Math.max(d.t1, d.t2);
      const bars = inp.bars.filter((b) => b.t >= t1 && b.t <= t2);
      if (!bars.length) continue;
      const row = autoRowSize(this.mainH / (this.yMax - this.yMin), inp.inst.fpRow, 6);
      const vp = volumeProfile(bars, row);
      if (!vp) continue;
      const x1 = this.xOfTime(t1) - this.barSpacing / 2;
      const x2 = this.xOfTime(t2) + this.barSpacing / 2;
      const width = Math.max(30, (x2 - x1) * 0.9);
      ctx.fillStyle = C.va;
      ctx.fillRect(x1, this.yOf(vp.vah + row), x2 - x1, this.yOf(vp.val) - this.yOf(vp.vah + row));
      for (const r of vp.rows) {
        const inVa = r.p >= vp.val && r.p <= vp.vah;
        const yT = this.yOf(r.p + row);
        const hh = Math.max(1, this.yOf(r.p) - yT - 0.5);
        ctx.fillStyle = r.p === vp.poc ? "rgba(250,204,21,0.75)" : inVa ? "rgba(96,165,250,0.5)" : "rgba(148,163,184,0.3)";
        ctx.fillRect(x1, yT, (r.v / vp.max) * width, hh);
      }
      ctx.strokeStyle = C.poc;
      ctx.beginPath();
      const yp = this.yOf(vp.poc + row / 2);
      ctx.moveTo(x1, yp);
      ctx.lineTo(x2, yp);
      ctx.stroke();
      ctx.font = C.fontSmall;
      ctx.fillStyle = C.poc;
      ctx.textAlign = "left";
      ctx.fillText(`POC ${fmtPrice(vp.poc, inp.inst.tickSize)}  VAH ${fmtPrice(vp.vah + row, inp.inst.tickSize)}  VAL ${fmtPrice(vp.val, inp.inst.tickSize)}`, x1 + 2, this.yOf(vp.vah + row) - 4);
      if (d.id === this.selected) {
        ctx.strokeStyle = C.accent;
        ctx.strokeRect(x1, this.yOf(vp.rows[vp.rows.length - 1].p + row), x2 - x1, this.yOf(vp.rows[0].p) - this.yOf(vp.rows[vp.rows.length - 1].p + row));
      }
    }
    ctx.font = C.font;
  }

  private drawDrawings(): void {
    const ctx = this.ctx;
    const all: Drawing[] = [...this.inp!.drawings];
    if (this.drag?.kind === "draw") {
      const d = this.drag;
      all.push({ id: "__tmp", kind: d.tool === "hline" ? "hline" : d.tool === "vprofile" ? "vprofile" : "trend", t1: d.t1, p1: d.p1, t2: d.t2, p2: d.p2, color: C.accent });
    }
    for (const d of all) {
      const sel = d.id === this.selected || d.id === "__tmp";
      ctx.strokeStyle = d.color;
      ctx.lineWidth = sel ? 2 : 1.3;
      if (d.kind === "trend" && d.t2 !== undefined && d.p2 !== undefined) {
        const x1 = this.xOfTime(d.t1);
        const y1 = this.yOf(d.p1);
        const x2 = this.xOfTime(d.t2);
        const y2 = this.yOf(d.p2);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        if (sel) {
          ctx.fillStyle = d.color;
          ctx.fillRect(x1 - 3, y1 - 3, 6, 6);
          ctx.fillRect(x2 - 3, y2 - 3, 6, 6);
        }
      } else if (d.kind === "hline") {
        const y = Math.round(this.yOf(d.p1)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(this.plotW, y);
        ctx.stroke();
        this.axisTag(d.p1, d.color, "");
      } else if (d.kind === "vprofile" && d.id === "__tmp" && d.t2 !== undefined) {
        const x1 = this.xOfTime(d.t1);
        const x2 = this.xOfTime(d.t2);
        ctx.fillStyle = "rgba(59,130,246,0.12)";
        ctx.fillRect(Math.min(x1, x2), this.mainTop, Math.abs(x2 - x1), this.mainH);
      }
    }
    ctx.lineWidth = 1;
  }

  private paneValues(key: string, from: number, to: number): { vals: number[]; min: number; max: number; kind: "hist" | "line" } {
    const bars = this.inp!.bars;
    const vals: number[] = [];
    let min = 0;
    let max = 0;
    const pick = (i: number): number => {
      const b = bars[i];
      switch (key) {
        case "volume":
          return this.unit(b.v);
        case "delta":
          return this.unit(b.d);
        case "cvd":
          return this.unit(this.cache.cvd[i] ?? 0);
        case "bell":
          return this.unit(this.cache.bell[i] ?? 0);
        case "intensity":
          return this.cache.intensity[i] ?? 0;
        default:
          return 0;
      }
    };
    for (let i = from; i <= to; i++) {
      const v = pick(i);
      vals.push(v);
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    if (key === "intensity") {
      min = 0;
      max = 100;
    }
    return { vals, min, max, kind: key === "cvd" ? "line" : "hist" };
  }

  private drawPane(p: Pane, from: number, to: number): void {
    const ctx = this.ctx;
    const inp = this.inp!;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, p.top, this.w, p.h);
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    ctx.moveTo(0, p.top + 0.5);
    ctx.lineTo(this.w, p.top + 0.5);
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, p.top + 1, this.plotW, p.h - 1);
    ctx.clip();
    if (p.key === "options") {
      const maps = inp.options.map((s) => new Map(s.bars.map((b) => [b.t, b])));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = from; i <= to; i++)
        for (const m of maps) {
          const b = m.get(inp.bars[i].t);
          if (b) {
            lo = Math.min(lo, b.l);
            hi = Math.max(hi, b.h);
          }
        }
      if (Number.isFinite(lo)) {
        const pad = (hi - lo) * 0.08 || 1;
        this.drawOptionCandles(from, to, maps, lo - pad, hi + pad, p.top + 4, p.h - 8, 1, false);
        ctx.restore();
        ctx.fillStyle = C.muted;
        ctx.font = C.fontSmall;
        ctx.textAlign = "left";
        ctx.fillText((hi + pad).toFixed(1), this.plotW + 4, p.top + 11);
        ctx.fillText((lo - pad).toFixed(1), this.plotW + 4, p.top + p.h - 4);
      } else ctx.restore();
      return;
    }
    const { vals, min, max, kind } = this.paneValues(p.key, from, to);
    const range = max - min || 1;
    const yOf = (v: number) => p.top + 4 + ((max - v) / range) * (p.h - 8);
    const bw = Math.max(1, Math.floor(this.barSpacing * 0.7));
    if (kind === "hist") {
      const zero = yOf(Math.max(0, min));
      for (let k = 0; k < vals.length; k++) {
        const i = from + k;
        const b = inp.bars[i];
        const x = Math.round(this.xOf(i));
        const v = vals[k];
        const y = yOf(v);
        if (p.key === "volume") ctx.fillStyle = b.c >= b.o ? C.upDim : C.downDim;
        else if (p.key === "delta") ctx.fillStyle = v >= 0 ? C.up : C.down;
        else if (p.key === "bell") ctx.fillStyle = "rgba(168,85,247,0.55)";
        else {
          const hue = v > 70 ? C.orange : v > 55 ? C.yellow : "rgba(100,116,139,0.6)";
          ctx.fillStyle = hue;
        }
        const top = Math.min(y, zero);
        ctx.fillRect(x - Math.floor(bw / 2), Math.round(top), bw, Math.max(1, Math.round(Math.abs(zero - y))));
      }
      if (p.key === "bell") {
        // overlay raw volume as a thin line to show the smoothing
        ctx.strokeStyle = "rgba(203,213,225,0.35)";
        ctx.beginPath();
        for (let k = 0; k < vals.length; k++) {
          const i = from + k;
          const y = yOf(Math.min(max, this.unit(inp.bars[i].v)));
          if (k === 0) ctx.moveTo(this.xOf(i), y);
          else ctx.lineTo(this.xOf(i), y);
        }
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = C.cyan;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let k = 0; k < vals.length; k++) {
        const x = this.xOf(from + k);
        const y = yOf(vals[k]);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = C.gridStrong;
      ctx.beginPath();
      ctx.moveTo(0, yOf(0));
      ctx.lineTo(this.plotW, yOf(0));
      ctx.stroke();
    }
    ctx.restore();
    ctx.font = C.fontSmall;
    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    const last = vals[vals.length - 1] ?? 0;
    ctx.fillText(`${p.label}${p.key === "intensity" ? "" : this.inp!.settings.units === "lots" ? " (lots)" : ""}  ${fmtNum(last)}`, 4, p.top + 11);
    ctx.fillText(fmtNum(max), this.plotW + 4, p.top + 11);
    if (min < 0) ctx.fillText(fmtNum(min), this.plotW + 4, p.top + p.h - 4);
    ctx.font = C.font;
  }

  private drawStats(top: number, from: number, to: number): void {
    const ctx = this.ctx;
    const inp = this.inp!;
    const h = STAT_ROWS.length * STAT_ROW + 4;
    ctx.fillStyle = C.panel;
    ctx.fillRect(0, top, this.w, h);
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(this.w, top + 0.5);
    ctx.stroke();
    ctx.font = C.fontSmall;
    ctx.textBaseline = "middle";
    const show = this.barSpacing >= 30;
    let maxAbs = 1;
    let maxVol = 1;
    for (let i = from; i <= to; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(inp.bars[i].d));
      maxVol = Math.max(maxVol, inp.bars[i].v);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.plotW, h);
    ctx.clip();
    if (show) {
      for (let i = from; i <= to; i++) {
        const b = inp.bars[i];
        const x = this.xOf(i);
        const vals = [b.d, b.dmin, b.dmax, this.cache.cvd[i] ?? 0, b.v];
        vals.forEach((v, r) => {
          const y = top + 2 + r * STAT_ROW;
          const a = r === 4 ? v / maxVol : Math.min(1, Math.abs(v) / maxAbs);
          ctx.fillStyle = r === 4 ? `rgba(59,130,246,${(0.1 + a * 0.45).toFixed(3)})` : v >= 0 ? `rgba(34,197,94,${(0.08 + a * 0.5).toFixed(3)})` : `rgba(239,68,68,${(0.08 + a * 0.5).toFixed(3)})`;
          ctx.fillRect(x - this.barSpacing / 2 + 1, y, this.barSpacing - 2, STAT_ROW - 1);
          ctx.fillStyle = C.text;
          ctx.textAlign = "center";
          ctx.fillText(fmtNum(this.unit(v)), x, y + STAT_ROW / 2);
        });
      }
    }
    ctx.restore();
    ctx.textAlign = "left";
    ctx.fillStyle = C.muted;
    STAT_ROWS.forEach((label, r) => ctx.fillText(label, this.plotW + 4, top + 2 + r * STAT_ROW + STAT_ROW / 2));
    if (!show) {
      ctx.fillStyle = C.muted;
      ctx.fillText("zoom in to see bar statistics", 6, top + h / 2);
    }
    ctx.textBaseline = "alphabetic";
    ctx.font = C.font;
  }

  private drawTimeAxis(top: number, from: number, to: number): void {
    const ctx = this.ctx;
    const bars = this.inp!.bars;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, top, this.w, TIME_H);
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5);
    ctx.lineTo(this.w, top + 0.5);
    ctx.stroke();
    ctx.fillStyle = C.axis;
    ctx.font = C.fontSmall;
    ctx.textAlign = "center";
    const minGap = 70;
    let lastX = -Infinity;
    for (let i = from; i <= to; i++) {
      const x = this.xOf(i);
      if (x - lastX < minGap || x < 20 || x > this.plotW - 20) continue;
      const newDay = i > 0 && istMidnight(bars[i].t) !== istMidnight(bars[i - 1].t);
      const b = bars[i];
      const mins = Math.round((b.t / MIN_MS) % 15);
      if (!newDay && mins !== 0 && this.barSpacing * 15 < minGap * 2) continue;
      ctx.fillStyle = newDay ? C.text : C.axis;
      ctx.fillText(newDay ? fmtDate(b.t) : fmtTime(b.t), x, top + 14);
      lastX = x;
    }
    ctx.font = C.font;
  }

  private axisTag(price: number, color: string, label: string): void {
    const ctx = this.ctx;
    const y = this.yOf(price);
    if (y < this.mainTop || y > this.mainTop + this.mainH) return;
    ctx.fillStyle = color;
    ctx.fillRect(this.plotW, y - 7, AXIS_W, 14);
    ctx.fillStyle = "#0b0f14";
    ctx.font = C.fontSmall;
    ctx.textAlign = "left";
    ctx.fillText(fmtPrice(price, this.inp!.inst.tickSize), this.plotW + 3, y + 3.5);
    if (label) {
      ctx.fillStyle = color;
      ctx.textAlign = "right";
      ctx.fillText(label, this.plotW - 3, y - 4);
    }
    ctx.font = C.font;
  }

  private drawPriceAxis(): void {
    const ctx = this.ctx;
    const inp = this.inp!;
    ctx.fillStyle = C.bg;
    ctx.fillRect(this.plotW, this.mainTop, AXIS_W, this.mainH);
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    ctx.moveTo(this.plotW + 0.5, 0);
    ctx.lineTo(this.plotW + 0.5, this.h);
    ctx.stroke();
    ctx.fillStyle = C.axis;
    ctx.font = C.fontSmall;
    ctx.textAlign = "left";
    const step = niceStep(this.yMax - this.yMin, Math.max(3, this.mainH / 55));
    for (let p = Math.ceil(this.yMin / step) * step; p <= this.yMax; p += step) {
      const y = this.yOf(p);
      if (y < 8 || y > this.mainH - 4) continue;
      ctx.fillText(fmtPrice(p, step >= 1 ? 1 : inp.inst.tickSize), this.plotW + 5, y + 3.5);
    }
    const last = inp.bars[inp.bars.length - 1];
    if (last) {
      const color = last.c >= last.o ? C.up : C.down;
      const y = Math.round(this.yOf(last.c)) + 0.5;
      ctx.strokeStyle = color;
      ctx.setLineDash([1, 2]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.axisTag(last.c, color, "");
    }
    if (this.manualScale) {
      ctx.fillStyle = C.yellow;
      ctx.font = C.fontSmall;
      ctx.fillText("M", this.w - 10, 11);
    }
    ctx.font = C.font;
  }

  private drawCrosshair(): void {
    const ctx = this.ctx;
    const m = this.mouse;
    let x: number | null = null;
    if (m && m.x < this.plotW) x = Math.round(this.xOf(Math.round(this.iOf(m.x)))) + 0.5;
    else if (this.extCross !== null) x = Math.round(this.xOfTime(this.extCross)) + 0.5;
    if (x === null) return;
    ctx.strokeStyle = C.crosshair;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, this.h - TIME_H);
    if (m && m.y < this.mainH && m.x < this.plotW) {
      ctx.moveTo(0, m.y + 0.5);
      ctx.lineTo(this.plotW, m.y + 0.5);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    if (m && m.y < this.mainH && m.x < this.plotW) {
      const p = this.pOf(m.y);
      ctx.fillStyle = "#334155";
      ctx.fillRect(this.plotW, m.y - 7, AXIS_W, 14);
      ctx.fillStyle = C.text;
      ctx.font = C.fontSmall;
      ctx.textAlign = "left";
      ctx.fillText(fmtPrice(p, this.inp!.inst.tickSize), this.plotW + 3, m.y + 3.5);
    }
    const i = m && m.x < this.plotW ? Math.round(this.iOf(m.x)) : Math.round(this.idxOfTime(this.extCross ?? 0));
    const t = this.timeOfIdx(i);
    const label = `${fmtDate(t)} ${fmtTime(t)}`;
    ctx.font = C.fontSmall;
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = "#334155";
    ctx.fillRect(x - tw / 2, this.h - TIME_H + 2, tw, TIME_H - 4);
    ctx.fillStyle = C.text;
    ctx.textAlign = "center";
    ctx.fillText(label, x, this.h - 6);
    ctx.font = C.font;
  }

  private drawLegend(): void {
    const ctx = this.ctx;
    const inp = this.inp!;
    const m = this.mouse;
    let i = inp.bars.length - 1;
    if (m && m.x < this.plotW) i = Math.max(0, Math.min(inp.bars.length - 1, Math.round(this.iOf(m.x))));
    const b = inp.bars[i];
    if (!b) return;
    const tick = inp.inst.tickSize;
    const chg = b.c - b.o;
    const txt = `O ${fmtPrice(b.o, tick)}  H ${fmtPrice(b.h, tick)}  L ${fmtPrice(b.l, tick)}  C ${fmtPrice(b.c, tick)}  Δ ${fmtNum(this.unit(b.d))}  V ${fmtNum(this.unit(b.v))}`;
    ctx.font = C.fontSmall;
    ctx.textAlign = "left";
    const w = ctx.measureText(txt).width + 10;
    ctx.fillStyle = "rgba(10,13,18,0.75)";
    ctx.fillRect(2, 2, w, 15);
    ctx.fillStyle = chg >= 0 ? "#86efac" : "#fca5a5";
    ctx.fillText(txt, 6, 13);
    if (inp.settings.mode === "footprint") {
      const size = this.rowSize();
      ctx.fillStyle = C.muted;
      ctx.fillText(`row ${size} (${Math.round(size / tick)} ticks) · imb ${Math.round(inp.settings.fpRatio * 100)}% ${inp.settings.fpMode}`, 6, 28);
    }
    ctx.font = C.font;
  }

  // ------------------------------------------------------------------ interaction

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private hitDrawing(x: number, y: number): Drawing | null {
    const inp = this.inp;
    if (!inp) return null;
    for (let k = inp.drawings.length - 1; k >= 0; k--) {
      const d = inp.drawings[k];
      if (d.kind === "hline") {
        if (Math.abs(this.yOf(d.p1) - y) < 5) return d;
      } else if (d.kind === "trend" && d.t2 !== undefined && d.p2 !== undefined) {
        const x1 = this.xOfTime(d.t1);
        const y1 = this.yOf(d.p1);
        const x2 = this.xOfTime(d.t2);
        const y2 = this.yOf(d.p2);
        const L = Math.hypot(x2 - x1, y2 - y1) || 1;
        const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / (L * L)));
        if (Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1))) < 6) return d;
      } else if (d.kind === "vprofile" && d.t2 !== undefined) {
        const x1 = this.xOfTime(Math.min(d.t1, d.t2)) - this.barSpacing / 2;
        const x2 = this.xOfTime(Math.max(d.t1, d.t2)) + this.barSpacing / 2;
        if (x >= x1 && x <= x2 && Math.abs(y - this.yOf(d.p1)) < this.mainH) {
          // select via the top label strip only, so panning inside the range still works
          const bars = inp.bars.filter((b) => b.t >= Math.min(d.t1, d.t2!) && b.t <= Math.max(d.t1, d.t2!));
          const hi = Math.max(...bars.map((b) => b.h));
          if (Math.abs(y - (this.yOf(hi) - 10)) < 14) return d;
        }
      }
    }
    return null;
  }

  private onDown = (e: MouseEvent): void => {
    if (!this.inp || e.button !== 0) return;
    const { x, y } = this.local(e);
    this.canvas.focus();
    this.downAt = { x, y };
    if (x >= this.plotW && y < this.mainH) {
      this.drag = { kind: "scale", y, min: this.yMin, max: this.yMax };
      return;
    }
    if (y > this.mainH) {
      this.drag = { kind: "pan", x, y, offset: this.offset, min: this.yMin, max: this.yMax, manual: false };
      return;
    }
    const t = this.timeOfIdx(this.iOf(x));
    const p = this.pOf(y);
    if (this.tool === "trend" || this.tool === "vprofile" || this.tool === "hline") {
      this.drag = { kind: "draw", tool: this.tool, t1: t, p1: p, t2: t, p2: p };
      this.dirty = true;
      return;
    }
    const hit = this.hitDrawing(x, y);
    if (hit) {
      this.selected = hit.id;
      this.drag = { kind: "move", id: hit.id, x, y, orig: { ...hit } };
      this.dirty = true;
      return;
    }
    this.selected = null;
    this.drag = { kind: "pan", x, y, offset: this.offset, min: this.yMin, max: this.yMax, manual: !!this.manualScale || e.shiftKey };
  };

  private onMove = (e: MouseEvent): void => {
    if (!this.inp) return;
    const pos = this.local(e);
    const inside = pos.x >= 0 && pos.y >= 0 && pos.x <= this.w && pos.y <= this.h;
    const d = this.drag;
    if (!d && !inside) return;
    this.mouse = inside ? pos : null;
    if (d?.kind === "pan") {
      this.offset = d.offset - (pos.x - d.x) / this.barSpacing;
      this.offset = Math.max(-this.n + 2, Math.min(this.plotW / this.barSpacing - 2, this.offset));
      if (d.manual && d.y < this.mainH) {
        const dp = ((pos.y - d.y) / this.mainH) * (d.max - d.min);
        this.manualScale = { min: d.min + dp, max: d.max + dp };
      }
    } else if (d?.kind === "scale") {
      const f = Math.exp((pos.y - d.y) / 150);
      const mid = (d.max + d.min) / 2;
      const half = ((d.max - d.min) / 2) * f;
      this.manualScale = { min: mid - half, max: mid + half };
    } else if (d?.kind === "draw") {
      d.t2 = this.timeOfIdx(this.iOf(pos.x));
      d.p2 = this.pOf(pos.y);
    } else if (d?.kind === "move") {
      const dt = this.timeOfIdx(this.iOf(pos.x)) - this.timeOfIdx(this.iOf(d.x));
      const dp = this.pOf(pos.y) - this.pOf(d.y);
      const o = d.orig;
      this.cb.onUpdateDrawing?.(d.id, {
        t1: o.t1 + dt,
        p1: o.p1 + dp,
        t2: o.t2 !== undefined ? o.t2 + dt : undefined,
        p2: o.p2 !== undefined ? o.p2 + dp : undefined,
      });
    }
    if (inside && pos.x < this.plotW) this.cb.onCrosshair?.(this.timeOfIdx(Math.round(this.iOf(pos.x))));
    this.dirty = true;
  };

  private onUp = (e: MouseEvent): void => {
    const d = this.drag;
    this.drag = null;
    if (!this.inp || !d) return;
    const pos = this.local(e);
    const moved = this.downAt ? Math.hypot(pos.x - this.downAt.x, pos.y - this.downAt.y) : 0;
    if (d.kind === "draw") {
      if (d.tool === "hline") this.cb.onAddDrawing?.({ kind: "hline", t1: d.t1, p1: d.p1 });
      else if (moved > 4) this.cb.onAddDrawing?.({ kind: d.tool === "vprofile" ? "vprofile" : "trend", t1: d.t1, p1: d.p1, t2: d.t2, p2: d.p2 });
      this.cb.onToolDone?.();
    } else if (d.kind === "pan" && moved < 3 && pos.y < this.mainH && pos.x < this.plotW) {
      const i = Math.round(this.iOf(pos.x));
      const b = this.inp.bars[i];
      if (b) this.cb.onBarClick?.(b.t);
    }
    this.dirty = true;
  };

  private onLeave = (): void => {
    this.mouse = null;
    this.cb.onCrosshair?.(null);
    this.dirty = true;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.inp) return;
    e.preventDefault();
    const { x, y } = this.local(e);
    const f = Math.exp(-e.deltaY * 0.0015);
    if (x >= this.plotW && y < this.mainH) {
      const mid = (this.yMax + this.yMin) / 2;
      const half = ((this.yMax - this.yMin) / 2) / f;
      this.manualScale = { min: mid - half, max: mid + half };
    } else {
      const anchorI = this.iOf(Math.min(x, this.plotW));
      const maxSp = this.inp.settings.mode === "footprint" ? 400 : 60;
      this.barSpacing = Math.max(1.5, Math.min(maxSp, this.barSpacing * f));
      // keep the bar under the cursor fixed
      this.offset = anchorI - (this.n - 1) - 0.5 - (Math.min(x, this.plotW) - this.plotW) / this.barSpacing;
    }
    this.dirty = true;
  };

  private onDbl = (e: MouseEvent): void => {
    const { x } = this.local(e);
    if (x >= this.plotW) this.manualScale = null;
    else this.resetView();
    this.dirty = true;
  };

  private onKey = (e: KeyboardEvent): void => {
    if ((e.key === "Delete" || e.key === "Backspace") && this.selected) {
      this.cb.onRemoveDrawing?.(this.selected);
      this.selected = null;
      this.dirty = true;
    } else if (e.key === "Escape") {
      this.drag = null;
      this.selected = null;
      this.cb.onToolDone?.();
      this.dirty = true;
    }
  };
}
