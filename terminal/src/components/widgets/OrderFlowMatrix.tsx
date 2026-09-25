"use client";
import { useEffect, useRef } from "react";
import { useSub } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { aggregate, rangeDays, tfMinutes, type AggBar } from "@/lib/data/aggregate";
import { getInstrument } from "@/lib/sim/instruments";
import { fmtTime, fmtDate, istMidnight } from "@/lib/sim/time";
import { useWorkspace } from "@/lib/state/workspace";
import { C, fmtNum } from "../chart/theme";
import { Seg, useSize } from "../ui";
import { TfSelect } from "../shell/TopBar";
import type { WidgetProps } from "./ChartWidget";

const LABEL_W = 78;

function shade(pct: number): number {
  const a = Math.abs(pct);
  return a > 75 ? 0.78 : a > 50 ? 0.52 : a > 25 ? 0.3 : 0.1;
}

/**
 * Order Flow Matrix: top histogram of aggregated volume and delta per bar, then
 * each bar decomposed into 1-minute intervals — Row 1 = delta %, Row 2 = volume
 * (lots) — with heat shading at >25% / >50% / >75% delta.
 */
export default function OrderFlowMatrix({ id, symbol, settings }: WidgetProps) {
  const global = useWorkspace((s) => s.ws.tf);
  const range = useWorkspace((s) => s.ws.range);
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const tfSetting = (settings.tf as string) ?? "5m";
  const tf = tfSetting === "global" ? global : tfSetting;
  const tfMin = tfMinutes(tf);
  const units = settings.units === "qty" ? "qty" : "lots";
  useSub({ kind: "bars", symbol, days: Math.min(rangeDays(range), 5) });

  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({ scroll: 0, dirty: true, drag: null as null | { x: number; s: number }, hover: null as null | { x: number; y: number } });
  const latest = useRef({ symbol, tfMin, units });
  latest.current = { symbol, tfMin, units };

  useEffect(() => {
    state.current.dirty = true;
  }, [symbol, tfMin, units, size.w, size.h]);

  useEffect(() => {
    const off = market.subscribe(`bars:${symbol}`, () => (state.current.dirty = true));
    return off;
  }, [symbol]);

  useEffect(() => {
    const c = canvasRef.current!;
    const ctx = c.getContext("2d", { alpha: false })!;
    let raf = 0;
    const st = state.current;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (!st.dirty) return;
      st.dirty = false;
      const { symbol: sym, tfMin: tfm, units: u } = latest.current;
      const inst = market.instrument(sym) ?? getInstrument(sym);
      const w = c.clientWidth;
      const h = c.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.floor(w * dpr) || c.height !== Math.floor(h * dpr)) {
        c.width = Math.floor(w * dpr);
        c.height = Math.floor(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = C.bg;
      ctx.fillRect(0, 0, w, h);
      const bars: AggBar[] = aggregate(sym, market.getBars(sym), tfm);
      if (!bars.length || !inst) {
        ctx.fillStyle = C.muted;
        ctx.font = C.font;
        ctx.textAlign = "center";
        ctx.fillText("Loading…", w / 2, h / 2);
        return;
      }
      const lot = u === "lots" ? inst.lotSize : 1;
      const subW = tfm <= 1 ? 58 : Math.max(26, Math.min(40, Math.floor(210 / tfm)));
      const colW = (b: AggBar) => Math.max(58, Math.max(1, b.subs.length) * subW);
      const headH = 16;
      const rowH = 20;
      const rows = tfm > 1 ? 4 : 2; // Δ% 1m, Vol 1m, bar Δ%, bar vol
      const gridH = rows * rowH;
      const histH = Math.max(40, h - headH - gridH - 4);
      // layout from the right edge
      const plotW = w - LABEL_W;
      const cols: { b: AggBar; x: number; cw: number }[] = [];
      let x = plotW + st.scroll;
      for (let i = bars.length - 1; i >= 0 && x > -400; i--) {
        const cw = colW(bars[i]);
        x -= cw;
        if (x < plotW) cols.push({ b: bars[i], x: x + LABEL_W, cw });
      }
      let maxV = 1;
      let maxD = 1;
      for (const c0 of cols) {
        maxV = Math.max(maxV, c0.b.v);
        maxD = Math.max(maxD, Math.abs(c0.b.d));
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(LABEL_W, 0, plotW, h);
      ctx.clip();
      ctx.font = C.fontSmall;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      const histTop = headH;
      const mid = histTop + histH * 0.55;
      for (const { b, x: cx0, cw } of cols) {
        // header
        const newDay = istMidnight(b.t) !== istMidnight(b.t - tfm * 60000) || fmtTime(b.t) === "09:15";
        ctx.fillStyle = newDay ? C.text : C.axis;
        ctx.fillText(newDay ? `${fmtDate(b.t)} ${fmtTime(b.t)}` : fmtTime(b.t), cx0 + cw / 2, 8);
        // histogram: volume (up from mid-baseline area) and delta (below)
        const vh = (b.v / maxV) * (histH * 0.55 - 12);
        ctx.fillStyle = "rgba(100,116,139,0.55)";
        ctx.fillRect(cx0 + cw * 0.18, mid - vh, cw * 0.28, vh);
        const dh = (Math.abs(b.d) / maxD) * (histH * 0.45 - 10);
        ctx.fillStyle = b.d >= 0 ? C.up : C.down;
        ctx.fillRect(cx0 + cw * 0.54, b.d >= 0 ? mid - dh : mid, cw * 0.28, dh);
        ctx.fillStyle = C.muted;
        ctx.fillText(fmtNum(b.v / lot), cx0 + cw * 0.32, Math.max(histTop + 6, mid - vh - 7));
        ctx.fillStyle = b.d >= 0 ? "#86efac" : "#fca5a5";
        ctx.fillText(fmtNum(b.d / lot), cx0 + cw * 0.68, b.d >= 0 ? Math.max(histTop + 6, mid - dh - 7) : Math.min(histTop + histH - 4, mid + dh + 7));
        // grid rows
        const gTop = histTop + histH + 4;
        const subs = b.subs.length ? b.subs : [b];
        const sw = cw / subs.length;
        if (tfm > 1) {
          subs.forEach((sb, k) => {
            const sx = cx0 + k * sw;
            const pct = sb.v ? (sb.d / sb.v) * 100 : 0;
            ctx.fillStyle = pct >= 0 ? `rgba(34,197,94,${shade(pct)})` : `rgba(239,68,68,${shade(pct)})`;
            ctx.fillRect(sx + 0.5, gTop + 0.5, sw - 1, rowH - 1);
            ctx.fillStyle = C.text;
            ctx.fillText(`${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%`, sx + sw / 2, gTop + rowH / 2);
            const va = sb.v / Math.max(1, b.v / subs.length) / 2;
            ctx.fillStyle = `rgba(59,130,246,${Math.min(0.7, 0.08 + va * 0.35).toFixed(3)})`;
            ctx.fillRect(sx + 0.5, gTop + rowH + 0.5, sw - 1, rowH - 1);
            ctx.fillStyle = C.text;
            ctx.fillText(fmtNum(sb.v / lot), sx + sw / 2, gTop + rowH * 1.5);
          });
        }
        const bTop = gTop + (tfm > 1 ? 2 * rowH : 0);
        const bp = b.v ? (b.d / b.v) * 100 : 0;
        ctx.fillStyle = bp >= 0 ? `rgba(34,197,94,${shade(bp)})` : `rgba(239,68,68,${shade(bp)})`;
        ctx.fillRect(cx0 + 0.5, bTop + 0.5, cw - 1, rowH - 1);
        ctx.fillStyle = C.text;
        ctx.fillText(`${bp >= 0 ? "+" : ""}${bp.toFixed(1)}%`, cx0 + cw / 2, bTop + rowH / 2);
        ctx.fillStyle = "rgba(59,130,246,0.18)";
        ctx.fillRect(cx0 + 0.5, bTop + rowH + 0.5, cw - 1, rowH - 1);
        ctx.fillStyle = C.text;
        ctx.fillText(fmtNum(b.v / lot), cx0 + cw / 2, bTop + rowH * 1.5);
        ctx.strokeStyle = C.gridStrong;
        ctx.beginPath();
        ctx.moveTo(cx0 + cw + 0.5, 0);
        ctx.lineTo(cx0 + cw + 0.5, h);
        ctx.stroke();
      }
      ctx.restore();
      // labels
      ctx.fillStyle = C.panel;
      ctx.fillRect(0, 0, LABEL_W, h);
      ctx.strokeStyle = C.gridStrong;
      ctx.beginPath();
      ctx.moveTo(LABEL_W - 0.5, 0);
      ctx.lineTo(LABEL_W - 0.5, h);
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();
      ctx.textAlign = "left";
      ctx.font = C.fontSmall;
      ctx.fillStyle = C.muted;
      ctx.fillText(`Volume (${u})`, 4, histTop + 10);
      ctx.fillText("Delta", 4, mid + 12);
      const gTop = histTop + histH + 4;
      const labels = tfm > 1 ? ["Row1 Δ% 1m", "Row2 Vol 1m", `Bar Δ% ${tfm}m`, "Bar volume"] : ["Bar Δ%", "Bar volume"];
      labels.forEach((l, k) => ctx.fillText(l, 4, gTop + k * rowH + rowH / 2));
    };
    render();
    const down = (e: MouseEvent) => (st.drag = { x: e.clientX, s: st.scroll });
    const move = (e: MouseEvent) => {
      if (!st.drag) return;
      st.scroll = Math.max(0, st.drag.s + e.clientX - st.drag.x);
      st.dirty = true;
    };
    const up = () => (st.drag = null);
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      st.scroll = Math.max(0, st.scroll + (e.deltaY || e.deltaX));
      st.dirty = true;
    };
    const dbl = () => {
      st.scroll = 0;
      st.dirty = true;
    };
    c.addEventListener("mousedown", down);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    c.addEventListener("wheel", wheel, { passive: false });
    c.addEventListener("dblclick", dbl);
    return () => {
      cancelAnimationFrame(raf);
      c.removeEventListener("mousedown", down);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      c.removeEventListener("wheel", wheel);
      c.removeEventListener("dblclick", dbl);
    };
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[24px] shrink-0 items-center gap-1 border-b border-line px-1">
        <TfSelect value={tfSetting} onChange={(v) => updateSettings(id, { tf: v })} />
        <Seg value={units} onChange={(v) => updateSettings(id, { units: v })} options={[{ value: "lots", label: "Lots" }, { value: "qty", label: "Qty" }]} />
        <span className="ml-1 truncate text-[10px] text-dim">{"5m+ bars split into 1-min intervals · shading at Δ% >25 / >50 / >75 · drag or wheel to scroll"}</span>
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-grab" />
      </div>
    </div>
  );
}
