"use client";
import { useEffect, useRef, useState } from "react";
import { useSub } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import type { Depth } from "@/lib/feed/protocol";
import { getInstrument } from "@/lib/sim/instruments";
import { useWorkspace } from "@/lib/state/workspace";
import { C, fmtNum, fmtPrice } from "../chart/theme";
import { Btn, Check, Empty, Sel, Seg, useSize } from "../ui";
import type { WidgetProps } from "./ChartWidget";

type Level = "L2" | "L3" | "L4";
const LEVELS: Record<Level, number> = { L2: 5, L3: 20, L4: 200 };
const ROW_H = 16;
const LADDER_W = 404;
const COLS = [
  { key: "my", w: 58, label: "My (paper)" },
  { key: "bo", w: 30, label: "Ord" },
  { key: "bq", w: 84, label: "Bid qty" },
  { key: "px", w: 70, label: "Price" },
  { key: "aq", w: 84, label: "Ask qty" },
  { key: "ao", w: 30, label: "Ord" },
  { key: "tv", w: 48, label: "Traded" },
] as const;

/** Ladder geometry: shrinks the columns on narrow tiles so the DOM surface keeps room. */
function ladderLayout(w: number, heatmap: boolean): { lx: number; ladderW: number; cols: { key: string; label: string; x: number; w: number }[] } {
  const ladderW = heatmap ? Math.min(LADDER_W, Math.max(250, w * 0.58)) : Math.min(LADDER_W, w);
  const scale = ladderW / LADDER_W;
  const lx = w - ladderW;
  let x = lx;
  const cols = COLS.map((c) => {
    const cw = c.w * scale;
    const o = { key: c.key, label: scale < 0.8 && c.key === "my" ? "My" : c.label, x, w: cw };
    x += cw;
    return o;
  });
  return { lx, ladderW, cols };
}

interface PaperOrder {
  id: number;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
  ahead: number;
  prevLevel: number;
  filled: boolean;
}

function ramp(v: number): [number, number, number] {
  const stops: [number, [number, number, number]][] = [
    [0, [10, 13, 18]],
    [0.2, [12, 48, 96]],
    [0.45, [29, 140, 230]],
    [0.7, [250, 204, 21]],
    [1, [255, 247, 214]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [a, ca] = stops[i - 1];
      const [b, cb] = stops[i];
      const t = (v - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

/**
 * Depth of Market ladder (L2 = 5 levels, L3 = 20 levels with order-by-order
 * queues, L4 = 200 levels) with a DOM Surface heatmap of resting liquidity over
 * time: walls, stacking/pulling, iceberg refills, traded bubbles. Clicking the
 * bid/ask column places a paper limit order whose queue position is tracked.
 */
export default function DomLadder({ id, symbol, settings }: WidgetProps) {
  const inst = getInstrument(symbol);
  const level = ((settings.level as Level) ?? "L3") as Level;
  const group = Number(settings.group) || 1;
  const autoCenter = settings.autoCenter !== false;
  const heatmap = settings.heatmap !== false;
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const tradable = inst && inst.kind !== "INDEX";
  useSub(tradable ? { kind: "depth", symbol, levels: LEVELS[level] } : null);
  const [orders, setOrders] = useState<PaperOrder[]>([]);
  const ordersRef = useRef<PaperOrder[]>([]);
  ordersRef.current = orders;
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const st = useRef({ dirty: true, center: 0, scroll: 0, traded: new Map<number, [number, number]>(), lastT: 0 });
  const latest = useRef({ symbol, level, group, autoCenter, heatmap });
  latest.current = { symbol, level, group, autoCenter, heatmap };

  useEffect(() => {
    st.current.traded = new Map();
    st.current.scroll = 0;
    setOrders([]);
  }, [symbol]);
  useEffect(() => {
    st.current.dirty = true;
  }, [level, group, autoCenter, heatmap, size.w, size.h, orders]);

  // process each depth update: traded-at-price and paper order queue positions
  useEffect(() => {
    if (!tradable) return;
    return market.subscribe(`depth:${symbol}`, () => {
      const s = st.current;
      const hist = market.depthHist.get(symbol) ?? [];
      const fresh = hist.filter((x) => x.t > s.lastT);
      if (!fresh.length) return;
      s.lastT = fresh[fresh.length - 1].t;
      let changed = false;
      const next = ordersRef.current.map((o) => ({ ...o }));
      for (const { d } of fresh) {
        for (const [p, b, sl] of d.traded) {
          const k = Math.round(p * 1e6) / 1e6;
          const e = s.traded.get(k) ?? [0, 0];
          e[0] += b;
          e[1] += sl;
          s.traded.set(k, e);
        }
        for (const o of next) {
          if (o.filled) continue;
          const side = o.side === "BUY" ? d.bids : d.asks;
          const lvl = side.find((l) => Math.abs(l[0] - o.price) < 1e-6);
          const q = lvl ? lvl[1] : 0;
          const tr = d.traded.find((t) => Math.abs(t[0] - o.price) < 1e-6);
          const hit = tr ? (o.side === "BUY" ? tr[2] : tr[1]) : 0;
          const cancels = Math.max(0, o.prevLevel - q - hit);
          const aheadBefore = o.ahead;
          o.ahead = Math.max(0, o.ahead - hit - (cancels * o.ahead) / Math.max(o.prevLevel, 1));
          o.prevLevel = q;
          const through = o.side === "BUY" ? d.ltp < o.price : d.ltp > o.price;
          if ((aheadBefore <= hit && hit > 0) || through) o.filled = true;
          changed = true;
        }
      }
      if (changed) setOrders(next);
      s.dirty = true;
    });
  }, [symbol, tradable]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d", { alpha: false })!;
    let raf = 0;
    const s = st.current;
    const render = () => {
      raf = requestAnimationFrame(render);
      if (!s.dirty) return;
      s.dirty = false;
      const L = latest.current;
      const ins = market.instrument(L.symbol);
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
      const d: Depth | undefined = market.depth.get(L.symbol);
      if (!d || !ins) {
        ctx.fillStyle = C.muted;
        ctx.font = C.font;
        ctx.textAlign = "center";
        ctx.fillText("Waiting for depth…", w / 2, h / 2);
        return;
      }
      const tick = ins.tickSize;
      const step = tick * L.group;
      const snap = (p: number) => Math.round(Math.floor(p / step + 1e-9) * step * 1e6) / 1e6;
      const HEAD = 16;
      const nRows = Math.max(5, Math.floor((h - HEAD) / ROW_H));
      if (L.autoCenter || !s.center) s.center = snap(d.ltp);
      const topPrice = Math.round((s.center + (Math.floor(nRows / 2) + s.scroll) * step) * 1e6) / 1e6;
      const rowOf = (p: number) => Math.round((topPrice - snap(p)) / step);
      const priceOfRow = (r: number) => Math.round((topPrice - r * step) * 1e6) / 1e6;
      const lay = ladderLayout(w, L.heatmap);
      const { lx, ladderW } = lay;
      const heatW = L.heatmap ? lx : 0;

      // aggregate current book into rows
      const agg = (levels: number[][]) => {
        const m = new Map<number, { q: number; o: number; sizes: number[] }>();
        for (const l of levels) {
          const r = rowOf(l[0]);
          const e = m.get(r) ?? { q: 0, o: 0, sizes: [] };
          e.q += l[1];
          e.o += l[2];
          if (l.length > 3) e.sizes.push(...l.slice(3));
          m.set(r, e);
        }
        return m;
      };
      const bids = agg(d.bids);
      const asks = agg(d.asks);
      let maxQ = 1;
      for (const e of bids.values()) maxQ = Math.max(maxQ, e.q);
      for (const e of asks.values()) maxQ = Math.max(maxQ, e.q);

      // ---------------- heatmap (DOM surface)
      if (heatW > 40) {
        const hist = market.depthHist.get(L.symbol) ?? [];
        const colPx = 2;
        const nCols = Math.min(hist.length, Math.floor(heatW / colPx));
        const samples = hist.slice(hist.length - nCols);
        let hMax = 1;
        const grid: Float32Array[] = samples.map((smp) => {
          const col = new Float32Array(nRows);
          for (const l of smp.d.bids) {
            const r = rowOf(l[0]);
            if (r >= 0 && r < nRows) col[r] += l[1];
          }
          for (const l of smp.d.asks) {
            const r = rowOf(l[0]);
            if (r >= 0 && r < nRows) col[r] += l[1];
          }
          for (let r = 0; r < nRows; r++) hMax = Math.max(hMax, col[r]);
          return col;
        });
        if (samples.length) {
          const img = ctx.createImageData(samples.length, nRows);
          const lm = Math.log1p(hMax);
          grid.forEach((col, x) => {
            for (let r = 0; r < nRows; r++) {
              const [R, G, B] = ramp(Math.log1p(col[r]) / lm);
              const i = (r * samples.length + x) * 4;
              img.data[i] = R;
              img.data[i + 1] = G;
              img.data[i + 2] = B;
              img.data[i + 3] = 255;
            }
          });
          const off = new OffscreenCanvas(samples.length, nRows);
          off.getContext("2d")!.putImageData(img, 0, 0);
          ctx.imageSmoothingEnabled = false;
          const x0 = heatW - samples.length * colPx;
          ctx.drawImage(off, x0, HEAD, samples.length * colPx, nRows * ROW_H);
          // last price path
          ctx.strokeStyle = "rgba(255,255,255,0.85)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          samples.forEach((smp, k) => {
            const y = HEAD + (rowOf(smp.d.ltp) + 0.5) * ROW_H;
            if (k === 0) ctx.moveTo(x0 + k * colPx, y);
            else ctx.lineTo(x0 + k * colPx, y);
          });
          ctx.stroke();
          // traded bubbles and liquidity events
          samples.forEach((smp, k) => {
            const x = x0 + k * colPx + 1;
            for (const [p, b, sl] of smp.d.traded) {
              const y = HEAD + (rowOf(p) + 0.5) * ROW_H;
              if (y < HEAD || y > h) continue;
              const qty = b + sl;
              const rad = Math.min(9, 1.5 + Math.sqrt(qty / ins.lotSize) * 0.7);
              ctx.fillStyle = b >= sl ? "rgba(34,197,94,0.75)" : "rgba(239,68,68,0.75)";
              ctx.beginPath();
              ctx.arc(x, y, rad, 0, Math.PI * 2);
              ctx.fill();
            }
            for (const ev of smp.d.events) {
              const y = HEAD + (rowOf(ev.price) + 0.5) * ROW_H;
              if (y < HEAD || y > h) continue;
              ctx.font = "bold 10px ui-monospace, monospace";
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = ev.type === "pull" ? "#facc15" : ev.type === "stack" ? "#22d3ee" : "#e879f9";
              ctx.fillText(ev.type === "pull" ? "✕" : ev.type === "stack" ? "+" : "◆", x, y);
            }
          });
        }
        ctx.fillStyle = C.muted;
        ctx.font = C.fontSmall;
        ctx.textAlign = "left";
        ctx.textBaseline = "alphabetic";
        ctx.fillText(heatW > 330 ? "DOM surface · ✕ pulled · + stacked · ◆ iceberg · ● traded" : "DOM surface", 4, 11);
      }

      // ---------------- ladder
      ctx.fillStyle = C.panel;
      ctx.fillRect(lx, 0, ladderW, h);
      ctx.font = C.fontSmall;
      ctx.textBaseline = "middle";
      const colX: Record<string, [number, number]> = {};
      for (const col of lay.cols) {
        colX[col.key] = [col.x, col.w];
        ctx.fillStyle = C.dim;
        ctx.textAlign = "center";
        ctx.fillText(col.label, col.x + col.w / 2, 8);
      }
      const lot = ins.lotSize;
      const my = ordersRef.current;
      for (let r = 0; r < nRows; r++) {
        const y = HEAD + r * ROW_H;
        const p = priceOfRow(r);
        const b = bids.get(r);
        const a = asks.get(r);
        const isLtp = rowOf(d.ltp) === r;
        ctx.fillStyle = r % 2 ? "#0e131a" : "#0c1117";
        ctx.fillRect(lx, y, ladderW, ROW_H);
        // price
        const [px, pw] = colX.px;
        ctx.fillStyle = isLtp ? "#1e3a5f" : "#111822";
        ctx.fillRect(px, y, pw, ROW_H - 1);
        ctx.fillStyle = isLtp ? "#fff" : C.text;
        ctx.textAlign = "center";
        ctx.fillText(fmtPrice(p, tick), px + pw / 2, y + ROW_H / 2);
        const drawQty = (e: { q: number; o: number; sizes: number[] } | undefined, key: "bq" | "aq", okey: "bo" | "ao", color: string, right: boolean) => {
          if (!e) return;
          const [qx, qw] = colX[key];
          const frac = e.q / maxQ;
          ctx.fillStyle = color;
          const bw = Math.max(2, frac * (qw - 4));
          ctx.fillRect(right ? qx + qw - 2 - bw : qx + 2, y + 2, bw, ROW_H - 4);
          if (L.level !== "L2" && e.sizes.length) {
            // order-by-order queue segments (front of queue nearest the price column)
            let off = 0;
            const tot = e.sizes.reduce((s0, v0) => s0 + v0, 0) || 1;
            ctx.strokeStyle = "rgba(10,13,18,0.9)";
            for (const sz of e.sizes) {
              off += (sz / tot) * bw;
              const sx = right ? qx + qw - 2 - off : qx + 2 + off;
              ctx.beginPath();
              ctx.moveTo(sx + 0.5, y + 2);
              ctx.lineTo(sx + 0.5, y + ROW_H - 2);
              ctx.stroke();
            }
          }
          ctx.fillStyle = "#e5e7eb";
          ctx.textAlign = right ? "right" : "left";
          ctx.fillText(fmtNum(e.q / lot), right ? qx + qw - 4 : qx + 4, y + ROW_H / 2);
          const [ox, ow] = colX[okey];
          ctx.fillStyle = C.muted;
          ctx.textAlign = "center";
          ctx.fillText(String(e.o), ox + ow / 2, y + ROW_H / 2);
        };
        drawQty(b, "bq", "bo", "rgba(59,130,246,0.45)", true);
        drawQty(a, "aq", "ao", "rgba(239,68,68,0.4)", false);
        // traded at price (session, since opened)
        const tv = s.traded.get(p);
        if (tv) {
          const [tx, tw] = colX.tv;
          ctx.fillStyle = tv[0] >= tv[1] ? "#86efac" : "#fca5a5";
          ctx.textAlign = "center";
          ctx.fillText(fmtNum((tv[0] + tv[1]) / lot), tx + tw / 2, y + ROW_H / 2);
        }
        // paper orders
        const mine = my.filter((o) => rowOf(o.price) === r);
        if (mine.length) {
          const [mx, mw] = colX.my;
          const o = mine[0];
          ctx.fillStyle = o.filled ? "rgba(34,197,94,0.35)" : o.side === "BUY" ? "rgba(59,130,246,0.35)" : "rgba(239,68,68,0.35)";
          ctx.fillRect(mx + 1, y + 1, mw - 2, ROW_H - 2);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "center";
          ctx.fillText(o.filled ? `${o.side[0]} FILLED` : `${o.side[0]} q${fmtNum(o.ahead / lot)}`, mx + mw / 2, y + ROW_H / 2);
        }
      }
      ctx.textBaseline = "alphabetic";
      // spread / imbalance footer
      const bidTot = d.bids.reduce((a0, l) => a0 + l[1], 0);
      const askTot = d.asks.reduce((a0, l) => a0 + l[1], 0);
      ctx.fillStyle = "rgba(10,13,18,0.9)";
      ctx.fillRect(lx, h - 14, ladderW, 14);
      ctx.fillStyle = C.muted;
      ctx.textAlign = "left";
      const spread = d.asks[0] && d.bids[0] ? d.asks[0][0] - d.bids[0][0] : 0;
      ctx.fillText(
        `${L.level} ${d.bids.length}×${d.asks.length} lvls · spread ${fmtPrice(spread, tick)} · bid ${fmtNum(bidTot / lot)} / ask ${fmtNum(askTot / lot)} lots (${((bidTot / Math.max(1, bidTot + askTot)) * 100).toFixed(0)}% bid)`,
        lx + 4,
        h - 4,
      );
    };
    render();
    const pos = (e: MouseEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const hitRow = (e: MouseEvent) => {
      const { x, y } = pos(e);
      const lay = ladderLayout(c.clientWidth, latest.current.heatmap);
      const d = market.depth.get(latest.current.symbol);
      const ins = market.instrument(latest.current.symbol);
      if (!d || !ins || x < lay.lx) return null;
      const key = lay.cols.find((col) => x >= col.x && x < col.x + col.w)?.key ?? "";
      const step = ins.tickSize * latest.current.group;
      const nRows = Math.max(5, Math.floor((c.clientHeight - 16) / ROW_H));
      const topPrice = s.center + (Math.floor(nRows / 2) + s.scroll) * step;
      const r = Math.floor((y - 16) / ROW_H);
      const price = Math.round((topPrice - r * step) * 1e6) / 1e6;
      return { key, price, d, ins };
    };
    const click = (e: MouseEvent) => {
      const hit = hitRow(e);
      if (!hit || (hit.key !== "bq" && hit.key !== "aq")) return;
      const side = hit.key === "bq" ? "BUY" : "SELL";
      const book = side === "BUY" ? hit.d.bids : hit.d.asks;
      const lvl = book.find((l) => Math.abs(l[0] - hit.price) < 1e-6);
      const q = lvl ? lvl[1] : 0;
      setOrders((os) => [...os.filter((o) => !o.filled || os.length < 12), { id: Date.now(), side, price: hit.price, qty: hit.ins.lotSize, ahead: q, prevLevel: q, filled: false }]);
    };
    const ctxMenu = (e: MouseEvent) => {
      const hit = hitRow(e);
      if (!hit) return;
      e.preventDefault();
      setOrders((os) => os.filter((o) => Math.abs(o.price - hit.price) > 1e-6));
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      s.scroll += e.deltaY > 0 ? -2 : 2;
      if (latest.current.autoCenter) updateSettings(id, { autoCenter: false });
      s.dirty = true;
    };
    c.addEventListener("click", click);
    c.addEventListener("contextmenu", ctxMenu);
    c.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cancelAnimationFrame(raf);
      c.removeEventListener("click", click);
      c.removeEventListener("contextmenu", ctxMenu);
      c.removeEventListener("wheel", wheel);
    };
  }, [id, updateSettings, tradable]);

  if (!inst) return <Empty>Unknown symbol</Empty>;
  if (!tradable) return <Empty>Depth needs a tradable instrument — pick a future, stock or option (e.g. {inst.symbol}-FUT).</Empty>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[24px] shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1">
        <Seg<Level>
          value={level}
          onChange={(v) => updateSettings(id, { level: v })}
          options={[
            { value: "L2", label: "L2", title: "5 levels, aggregated" },
            { value: "L3", label: "L3", title: "20 levels, order-by-order queues" },
            { value: "L4", label: "L4", title: "200 levels full depth" },
          ]}
        />
        <Sel value={group} onChange={(v) => updateSettings(id, { group: v })} options={[1, 2, 5, 10, 20].map((g) => ({ value: g, label: `${g} tick${g > 1 ? "s" : ""}` }))} />
        <Check checked={autoCenter} onChange={(v) => { st.current.scroll = 0; updateSettings(id, { autoCenter: v }); }} label="Auto-center" />
        <Check checked={heatmap} onChange={(v) => updateSettings(id, { heatmap: v })} label="DOM surface" />
        {orders.length > 0 && (
          <Btn onClick={() => setOrders([])} danger>
            Clear {orders.length} paper
          </Btn>
        )}
        <span className="ml-1 truncate text-[10px] text-dim">click bid/ask = paper limit · right-click = cancel · wheel = scroll</span>
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full cursor-pointer" />
      </div>
    </div>
  );
}
