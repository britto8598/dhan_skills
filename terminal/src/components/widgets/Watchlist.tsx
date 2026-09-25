"use client";
import { useEffect, useRef, useState } from "react";
import { useSub, useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { displayName } from "@/lib/sim/instruments";
import { istMidnight } from "@/lib/sim/time";
import { useWorkspace } from "@/lib/state/workspace";
import { fmtNum, fmtPrice } from "../chart/theme";
import { cx } from "../ui";
import { SymbolSearch } from "../grid/SymbolSearch";
import type { WidgetProps } from "./ChartWidget";

function Sparkline({ symbol }: { symbol: string }) {
  useSub({ kind: "bars", symbol, days: 1 });
  useTopic(`bars:${symbol}`, 1000);
  const ref = useRef<HTMLCanvasElement>(null);
  const bars = market.getBars(symbol);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const W = 240;
    const H = 96;
    c.width = W * dpr;
    c.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const today = bars.length ? istMidnight(bars[bars.length - 1].t) : 0;
    const pts = bars.filter((b) => b.t >= today);
    if (pts.length < 2) return;
    const lo = Math.min(...pts.map((b) => b.l));
    const hi = Math.max(...pts.map((b) => b.h));
    const up = pts[pts.length - 1].c >= pts[0].o;
    const y = (p: number) => 6 + ((hi - p) / (hi - lo || 1)) * (H - 12);
    ctx.strokeStyle = up ? "#22c55e" : "#ef4444";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    pts.forEach((b, i) => {
      const x = (i / (pts.length - 1)) * (W - 4) + 2;
      if (i === 0) ctx.moveTo(x, y(b.c));
      else ctx.lineTo(x, y(b.c));
    });
    ctx.stroke();
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = "#475569";
    ctx.beginPath();
    ctx.moveTo(0, y(pts[0].o));
    ctx.lineTo(W, y(pts[0].o));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(`H ${hi.toFixed(2)}`, 4, 11);
    ctx.fillText(`L ${lo.toFixed(2)}`, 4, H - 3);
  });
  return <canvas ref={ref} style={{ width: 240, height: 96 }} />;
}

/** Grouped watchlists with hover chart previews; clicking links the symbol to the widget's channel. */
export default function Watchlist({ id, settings, channel }: WidgetProps) {
  useTopic("quotes", 1000);
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const setSymbol = useWorkspace((s) => s.setSymbol);
  const groups = (settings.groups as Record<string, string[]>) ?? {};
  const names = Object.keys(groups);
  const group = names.includes(settings.group as string) ? (settings.group as string) : names[0];
  const syms = groups[group] ?? [];
  const [hover, setHover] = useState<{ s: string; y: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const setGroups = (g: Record<string, string[]>, active?: string) => updateSettings(id, { groups: g, ...(active ? { group: active } : {}) });

  return (
    <div className="relative flex h-full flex-col text-[11px]" onMouseLeave={() => setHover(null)}>
      <div className="flex h-[24px] shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-1">
        {names.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => updateSettings(id, { group: n })}
            onDoubleClick={() => {
              const nn = prompt("Rename group", n)?.trim();
              if (nn && nn !== n && !groups[nn]) {
                const g = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k === n ? nn : k, v]));
                setGroups(g, nn);
              }
            }}
            className={cx("h-[20px] rounded-[3px] px-2 whitespace-nowrap", n === group ? "bg-accent/25 text-[#bfdbfe]" : "text-muted hover:bg-panel3")}
            title="Double-click to rename"
          >
            {n}
          </button>
        ))}
        <button
          type="button"
          className="h-[20px] px-1.5 text-muted hover:text-fg"
          title="New group"
          onClick={() => {
            const n = prompt("New watchlist group")?.trim();
            if (n && !groups[n]) setGroups({ ...groups, [n]: [] }, n);
          }}
        >
          ＋
        </button>
        <div className="flex-1" />
        {adding ? (
          <SymbolSearch
            value="ADD"
            onChange={(s) => {
              if (!syms.includes(s)) setGroups({ ...groups, [group]: [...syms, s] });
              setAdding(false);
            }}
          />
        ) : (
          <button type="button" className="h-[20px] rounded-[3px] px-1.5 text-muted hover:bg-panel3 hover:text-fg" onClick={() => setAdding(true)}>
            ＋ Symbol
          </button>
        )}
        {names.length > 1 && (
          <button
            type="button"
            className="h-[20px] px-1.5 text-dim hover:text-down"
            title={`Delete group ${group}`}
            onClick={() => {
              if (!confirm(`Delete group “${group}”?`)) return;
              const g = { ...groups };
              delete g[group];
              setGroups(g, Object.keys(g)[0]);
            }}
          >
            🗑
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="num w-full text-right">
          <thead className="sticky top-0 z-10 bg-panel2 text-[10px] text-dim">
            <tr>
              <th className="px-1.5 py-0.5 text-left font-normal">Symbol</th>
              <th className="px-1 font-normal">LTP</th>
              <th className="px-1 font-normal">Chg</th>
              <th className="px-1 font-normal">Chg%</th>
              <th className="px-1 font-normal">Volume</th>
              <th className="px-1 font-normal">High</th>
              <th className="px-1 font-normal">Low</th>
              <th className="w-5" />
            </tr>
          </thead>
          <tbody>
            {syms.map((s) => {
              const q = market.quotes.get(s);
              const inst = market.instrument(s);
              const chg = q ? q.ltp - q.pc : 0;
              const pct = q?.pc ? (chg / q.pc) * 100 : 0;
              return (
                <tr
                  key={s}
                  className="group cursor-pointer border-b border-line/40 hover:bg-panel3"
                  onClick={() => setSymbol(id, s)}
                  onMouseEnter={(e) => setHover({ s, y: (e.currentTarget as HTMLElement).offsetTop + 24 })}
                  title={channel === "none" ? "Set a link channel to drive charts" : `Link to ${channel} channel`}
                >
                  <td className="px-1.5 py-[3px] text-left font-semibold">{displayName(s)}</td>
                  <td className="px-1">{q ? fmtPrice(q.ltp, inst?.tickSize) : "—"}</td>
                  <td className={cx("px-1", chg >= 0 ? "text-up" : "text-down")}>{q ? chg.toFixed(2) : ""}</td>
                  <td className={cx("px-1", chg >= 0 ? "text-up" : "text-down")}>{q ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : ""}</td>
                  <td className="px-1 text-muted">{q && q.v ? fmtNum(q.v / (inst?.lotSize || 1)) : "—"}</td>
                  <td className="px-1 text-muted">{q ? fmtPrice(q.h, inst?.tickSize) : ""}</td>
                  <td className="px-1 text-muted">{q ? fmtPrice(q.l, inst?.tickSize) : ""}</td>
                  <td className="px-1">
                    <button
                      type="button"
                      className="invisible text-dim group-hover:visible hover:text-down"
                      onClick={(e) => {
                        e.stopPropagation();
                        setGroups({ ...groups, [group]: syms.filter((x) => x !== s) });
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!syms.length && <div className="p-3 text-center text-dim">Empty group — add symbols with ＋ Symbol.</div>}
        <div className="px-2 py-1 text-[10px] text-dim">Volume in lots · hover a row for a chart preview</div>
      </div>
      {hover && (
        <div className="pointer-events-none absolute right-2 z-20 rounded border border-line2 bg-panel2 p-1.5 shadow-xl shadow-black/60" style={{ top: Math.min(hover.y, 9999) }}>
          <div className="mb-0.5 text-[10px] font-semibold">{displayName(hover.s)} · today</div>
          <Sparkline symbol={hover.s} />
        </div>
      )}
    </div>
  );
}
