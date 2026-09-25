/**
 * TPO / Market Profile canvas: one column per profile segment (a session by
 * default). Letters or blocks coloured by period, value area shading, POC,
 * VAH/VAL, single prints, initial balance, open/close markers. Click selects
 * profiles (shift = multi); in split mode clicking a letter splits the profile
 * at that period.
 */
import type { Bar } from "@/lib/feed/protocol";
import type { Instrument } from "@/lib/sim/instruments";
import { buildTpo, tpoSegments, TPO_LETTERS, autoTpoRow, type TpoProfile } from "@/lib/analytics/tpo";
import { fmtDate, fmtTime, sessionOpen, MIN_MS } from "@/lib/sim/time";
import { C, fmtPrice, niceStep } from "./theme";

export interface TpoInputs {
  bars: Bar[]; // 1-minute
  inst: Instrument;
  periodMin: number;
  row: "auto" | number;
  mode: "letters" | "blocks";
  merges: number[];
  splits: number[];
  selected: number[]; // profile start times
  splitMode: boolean;
}

export interface TpoCallbacks {
  onSelect?: (starts: number[]) => void;
  onSplit?: (t: number) => void;
  onProfiles?: (p: TpoProfile[]) => void;
}

const AXIS_W = 66;
const HEAD_H = 42;

function periodColor(idx: number, alpha = 1): string {
  const hue = (idx * 29 + 190) % 360;
  return `hsla(${hue},70%,62%,${alpha})`;
}

export class TpoChartEngine {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private inp: TpoInputs | null = null;
  private profiles: TpoProfile[] = [];
  private profKey = "";
  private rowPx = 12;
  private center: number | null = null; // price at vertical centre (null = auto)
  private scrollX = 0; // px from the right end
  private cols: { x: number; w: number; p: TpoProfile }[] = [];
  private drag: { x: number; y: number; scroll: number; center: number; moved: boolean } | null = null;
  private mouse: { x: number; y: number } | null = null;
  private dirty = true;
  private raf = 0;
  private destroyed = false;
  private rowSize = 1;

  constructor(private canvas: HTMLCanvasElement, private cb: TpoCallbacks = {}) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    canvas.addEventListener("mousedown", this.onDown);
    window.addEventListener("mousemove", this.onMove);
    window.addEventListener("mouseup", this.onUp);
    canvas.addEventListener("mouseleave", this.onLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("dblclick", this.onDbl);
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
  }

  setCallbacks(cb: TpoCallbacks): void {
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

  setInputs(inp: TpoInputs): void {
    if (this.inp?.inst.symbol !== inp.inst.symbol) {
      this.center = null;
      this.scrollX = 0;
    }
    this.inp = inp;
    this.canvas.style.cursor = inp.splitMode ? "col-resize" : "default";
    const b = inp.bars;
    const last = b[b.length - 1];
    const row = inp.row === "auto" ? autoTpoRow(b, inp.inst.fpRow, 42) : inp.row;
    const key = `${inp.inst.symbol}|${b.length}|${last?.t}|${last?.h}|${last?.l}|${inp.periodMin}|${row}|${inp.merges.join(",")}|${inp.splits.join(",")}`;
    if (key !== this.profKey) {
      this.profKey = key;
      this.rowSize = row;
      this.profiles = tpoSegments(b, inp.merges, inp.splits)
        .map((s) => buildTpo(b, s.start, s.end, inp.periodMin, row))
        .filter((p): p is TpoProfile => !!p);
      this.cb.onProfiles?.(this.profiles);
    }
    this.dirty = true;
  }

  resetView(): void {
    this.center = null;
    this.scrollX = 0;
    this.rowPx = 12;
    this.dirty = true;
  }

  private loop = (): void => {
    if (this.destroyed) return;
    if (this.dirty) {
      this.dirty = false;
      try {
        this.render();
      } catch (e) {
        console.error("[tpo]", e);
      }
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private get plotW(): number {
    return this.w - AXIS_W;
  }

  private pxPerPrice(): number {
    return this.rowPx / this.rowSize;
  }

  private yOf(p: number, mid: number): number {
    return HEAD_H + (this.h - HEAD_H) / 2 - (p - mid) * this.pxPerPrice();
  }

  private pOf(y: number, mid: number): number {
    return mid - (y - HEAD_H - (this.h - HEAD_H) / 2) / this.pxPerPrice();
  }

  private cellW(): number {
    return Math.max(5, Math.min(11, this.rowPx * 0.78));
  }

  private layout(): number {
    const cw = this.cellW();
    let x = 0;
    const cols = this.profiles.map((p) => {
      const w = Math.max(92, 26 + p.maxCount * cw + 12);
      const c = { x, w, p };
      x += w + 6;
      return c;
    });
    const total = x;
    const shift = Math.max(0, total - this.plotW) - this.scrollX;
    for (const c of cols) c.x -= shift;
    this.cols = cols;
    return total;
  }

  private midPrice(): number {
    if (this.center !== null) return this.center;
    const last = this.profiles[this.profiles.length - 1];
    if (!last) return 0;
    // fit the latest profile
    const range = last.high - last.low;
    const avail = this.h - HEAD_H - 20;
    if (range > 0) this.rowPx = Math.max(4, Math.min(16, (avail / (range / this.rowSize + 4))));
    return (last.high + last.low) / 2;
  }

  private render(): void {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.font = C.font;
    const inp = this.inp;
    if (!inp || !this.profiles.length) {
      ctx.fillStyle = C.muted;
      ctx.textAlign = "center";
      ctx.fillText(inp ? "Waiting for data…" : "Loading…", this.w / 2, this.h / 2);
      return;
    }
    const mid = this.midPrice();
    this.layout();
    const tick = inp.inst.tickSize;
    const cw = this.cellW();

    // grid
    const pLo = this.pOf(this.h, mid);
    const pHi = this.pOf(HEAD_H, mid);
    const step = niceStep(pHi - pLo, Math.max(3, (this.h - HEAD_H) / 50));
    ctx.strokeStyle = C.grid;
    ctx.beginPath();
    for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) {
      const y = Math.round(this.yOf(p, mid)) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotW, y);
    }
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.plotW, this.h);
    ctx.clip();
    const fontPx = Math.max(7, Math.min(12, Math.floor(this.rowPx * 0.85)));
    for (const col of this.cols) {
      if (col.x + col.w < 0 || col.x > this.plotW) continue;
      const p = col.p;
      const x0 = col.x;
      const rowY = (price: number) => this.yOf(price + this.rowSize, mid);
      const selected = inp.selected.includes(p.start);
      // value area band
      ctx.fillStyle = "rgba(59,130,246,0.07)";
      ctx.fillRect(x0, rowY(p.vah), col.w, this.yOf(p.val, mid) - rowY(p.vah));
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.font = `${fontPx}px ui-monospace, Menlo, Consolas, monospace`;
      const singles = new Set(p.singles);
      for (const r of p.rows) {
        const yT = rowY(r.p);
        const hh = this.yOf(r.p, mid) - yT;
        if (yT > this.h || yT + hh < HEAD_H) continue;
        const inVa = r.p >= p.val && r.p <= p.vah;
        r.periods.forEach((idx, k) => {
          const cx = x0 + 22 + k * cw;
          if (inp.mode === "blocks" || fontPx < 8) {
            ctx.fillStyle = periodColor(idx, inVa ? 0.85 : 0.45);
            ctx.fillRect(cx, yT + 0.5, cw - 1, Math.max(1, hh - 1));
          } else {
            ctx.fillStyle = periodColor(idx, inVa ? 1 : 0.55);
            ctx.fillText(TPO_LETTERS[idx % TPO_LETTERS.length], cx + cw / 2, yT + hh / 2 + 0.5);
          }
        });
        if (singles.has(r.p)) {
          ctx.fillStyle = C.orange;
          ctx.fillRect(x0 + 3, yT, 3, Math.max(1, hh));
        }
      }
      // initial balance
      if (p.ibHigh !== null && p.ibLow !== null) {
        ctx.fillStyle = C.cyan;
        const yH = this.yOf(p.ibHigh, mid);
        const yL = this.yOf(p.ibLow, mid);
        ctx.fillRect(x0 + 9, yH, 3, yL - yH);
        ctx.font = C.fontSmall;
        ctx.textAlign = "left";
        ctx.fillText("IB", x0 + 3, yH - 6);
      }
      // POC and VA bounds
      const yPoc = rowY(p.poc) + this.rowPx / 2;
      ctx.strokeStyle = C.poc;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0 + 14, yPoc);
      ctx.lineTo(x0 + col.w - 4, yPoc);
      ctx.stroke();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(96,165,250,0.8)";
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      const yVah = rowY(p.vah);
      const yVal = this.yOf(p.val, mid);
      ctx.moveTo(x0 + 14, yVah);
      ctx.lineTo(x0 + col.w - 4, yVah);
      ctx.moveTo(x0 + 14, yVal);
      ctx.lineTo(x0 + col.w - 4, yVal);
      ctx.stroke();
      ctx.setLineDash([]);
      // open / close markers
      ctx.fillStyle = C.text;
      const yo = this.yOf(p.open, mid);
      ctx.beginPath();
      ctx.moveTo(x0 + 14, yo - 4);
      ctx.lineTo(x0 + 20, yo);
      ctx.lineTo(x0 + 14, yo + 4);
      ctx.fill();
      const yc = this.yOf(p.close, mid);
      ctx.fillStyle = p.close >= p.open ? C.up : C.down;
      ctx.beginPath();
      ctx.moveTo(x0 + col.w - 2, yc - 4);
      ctx.lineTo(x0 + col.w - 8, yc);
      ctx.lineTo(x0 + col.w - 2, yc + 4);
      ctx.fill();
      // header (clipped to the column)
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, col.w, HEAD_H);
      ctx.clip();
      ctx.fillStyle = selected ? "rgba(59,130,246,0.25)" : C.panel;
      ctx.fillRect(x0, 0, col.w, HEAD_H - 2);
      ctx.fillStyle = C.text;
      const fullDay = p.start === sessionOpen(p.start) && p.days === 1 && p.end - p.start >= 370 * MIN_MS;
      ctx.fillText(p.days > 1 ? `${fmtDate(p.start)} +${p.days - 1}d` : fmtDate(p.start), x0 + 4, 12);
      ctx.fillStyle = C.muted;
      ctx.fillText(fullDay ? `TPO ${p.total}` : `${fmtTime(p.start)}–${fmtTime(p.end)} · ${p.total}`, x0 + 4, 24);
      ctx.fillStyle = C.poc;
      ctx.fillText(`POC ${fmtPrice(p.poc, tick)}`, x0 + 4, 36);
      ctx.fillStyle = "rgba(147,197,253,0.9)";
      const vaTxt = `${fmtPrice(p.val, tick)}–${fmtPrice(p.vah + this.rowSize, tick)}`;
      if (col.w > 150) ctx.fillText(`VA ${vaTxt}`, x0 + 4 + ctx.measureText(`POC ${fmtPrice(p.poc, tick)}  `).width, 36);
      ctx.restore();
      if (selected) {
        ctx.strokeStyle = C.accent;
        ctx.strokeRect(x0 + 0.5, 0.5, col.w - 1, this.h - 1);
      }
    }
    ctx.restore();

    // split-mode hover guide
    if (inp.splitMode && this.mouse) {
      const hit = this.hitLetter(this.mouse.x, this.mouse.y, mid);
      if (hit) {
        ctx.fillStyle = C.orange;
        ctx.font = C.fontSmall;
        ctx.textAlign = "left";
        ctx.fillText(`split at ${fmtTime(hit.t)}`, this.mouse.x + 10, this.mouse.y - 8);
      }
    }

    // price axis
    ctx.fillStyle = C.bg;
    ctx.fillRect(this.plotW, 0, AXIS_W, this.h);
    ctx.strokeStyle = C.gridStrong;
    ctx.beginPath();
    ctx.moveTo(this.plotW + 0.5, 0);
    ctx.lineTo(this.plotW + 0.5, this.h);
    ctx.stroke();
    ctx.fillStyle = C.axis;
    ctx.font = C.fontSmall;
    ctx.textAlign = "left";
    for (let p = Math.ceil(pLo / step) * step; p <= pHi; p += step) {
      const y = this.yOf(p, mid);
      if (y < HEAD_H + 6) continue;
      ctx.fillText(fmtPrice(p, step >= 1 ? 1 : tick), this.plotW + 5, y + 3.5);
    }
    const lastBar = inp.bars[inp.bars.length - 1];
    if (lastBar) {
      const y = this.yOf(lastBar.c, mid);
      ctx.fillStyle = C.accent;
      ctx.fillRect(this.plotW, y - 7, AXIS_W, 14);
      ctx.fillStyle = "#fff";
      ctx.fillText(fmtPrice(lastBar.c, tick), this.plotW + 3, y + 3.5);
      ctx.strokeStyle = "rgba(59,130,246,0.5)";
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.mouse && this.mouse.x < this.plotW && this.mouse.y > HEAD_H) {
      const p = this.pOf(this.mouse.y, mid);
      ctx.strokeStyle = C.crosshair;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(0, this.mouse.y + 0.5);
      ctx.lineTo(this.plotW, this.mouse.y + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#334155";
      ctx.fillRect(this.plotW, this.mouse.y - 7, AXIS_W, 14);
      ctx.fillStyle = C.text;
      ctx.fillText(fmtPrice(p, tick), this.plotW + 3, this.mouse.y + 3.5);
    }
    ctx.fillStyle = C.muted;
    ctx.fillText(`row ${this.rowSize} · ${inp.periodMin}m periods`, 6, this.h - 6);
  }

  private hitCol(x: number): { x: number; w: number; p: TpoProfile } | undefined {
    return this.cols.find((c) => x >= c.x && x <= c.x + c.w);
  }

  private hitLetter(x: number, y: number, mid: number): { t: number } | null {
    const col = this.hitCol(x);
    if (!col) return null;
    const price = this.pOf(y, mid);
    const r = col.p.rows.find((rw) => price >= rw.p && price < rw.p + this.rowSize);
    if (!r) return null;
    const k = Math.floor((x - col.x - 22) / this.cellW());
    const idx = r.periods[k];
    if (idx === undefined) return null;
    // absolute time of that period in the profile's day containing it
    const t = col.p.periodStarts.find((ps) => Math.round((ps - sessionOpen(ps)) / ((this.inp?.periodMin ?? 30) * MIN_MS)) === idx);
    if (t === undefined || t <= col.p.start) return null;
    return { t };
  }

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const { x, y } = this.local(e);
    this.drag = { x, y, scroll: this.scrollX, center: this.midPrice(), moved: false };
  };

  private onMove = (e: MouseEvent): void => {
    const pos = this.local(e);
    const inside = pos.x >= 0 && pos.y >= 0 && pos.x <= this.w && pos.y <= this.h;
    const d = this.drag;
    if (!d && !inside) return;
    this.mouse = inside ? pos : null;
    if (d) {
      const dx = pos.x - d.x;
      const dy = pos.y - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) {
        this.scrollX = Math.max(0, d.scroll + dx);
        this.center = d.center + dy / this.pxPerPrice();
      }
    }
    this.dirty = true;
  };

  private onUp = (e: MouseEvent): void => {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved || !this.inp) return;
    const { x, y } = this.local(e);
    const mid = this.midPrice();
    if (this.inp.splitMode) {
      const hit = this.hitLetter(x, y, mid);
      if (hit) this.cb.onSplit?.(hit.t);
      return;
    }
    const col = this.hitCol(x);
    if (!col) {
      this.cb.onSelect?.([]);
      return;
    }
    const cur = this.inp.selected;
    const s = col.p.start;
    if (e.shiftKey || e.ctrlKey || e.metaKey) this.cb.onSelect?.(cur.includes(s) ? cur.filter((v) => v !== s) : [...cur, s]);
    else this.cb.onSelect?.(cur.length === 1 && cur[0] === s ? [] : [s]);
  };

  private onLeave = (): void => {
    this.mouse = null;
    this.dirty = true;
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const mid = this.midPrice();
    const { y } = this.local(e);
    const anchor = this.pOf(y, mid);
    this.rowPx = Math.max(3, Math.min(28, this.rowPx * Math.exp(-e.deltaY * 0.0015)));
    // keep the price under the cursor fixed
    this.center = anchor + (y - HEAD_H - (this.h - HEAD_H) / 2) / this.pxPerPrice();
    this.dirty = true;
  };

  private onDbl = (): void => this.resetView();
}
