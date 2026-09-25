"use client";
import { useEffect } from "react";
import { useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { BASE_INSTRUMENTS } from "@/lib/sim/instruments";
import { fmtTime, istMinuteOfDay, SESSION_OPEN_MIN } from "@/lib/sim/time";
import { useWorkspace } from "@/lib/state/workspace";
import { Seg, cx } from "../ui";
import type { WidgetProps } from "./ChartWidget";

interface HLEvent {
  t: number;
  s: string;
  type: "HIGH" | "LOW";
  price: number;
  chgPct: number;
}

// shared across widget instances so the feed keeps history while widgets remount
const events: HLEvent[] = [];
const last = new Map<string, { h: number; l: number }>();
let started = false;

function startTracking(): void {
  if (started) return;
  started = true;
  market.subscribe("quotes", () => {
    const warm = istMinuteOfDay(market.simTime) >= SESSION_OPEN_MIN + 5;
    for (const inst of BASE_INSTRUMENTS) {
      if (inst.symbol === "INDIAVIX") continue;
      const q = market.quotes.get(inst.symbol);
      if (!q) continue;
      const prev = last.get(inst.symbol);
      if (prev && warm) {
        const chgPct = q.pc ? ((q.ltp - q.pc) / q.pc) * 100 : 0;
        if (q.h > prev.h) events.unshift({ t: market.simTime, s: inst.symbol, type: "HIGH", price: q.h, chgPct });
        if (q.l < prev.l) events.unshift({ t: market.simTime, s: inst.symbol, type: "LOW", price: q.l, chgPct });
      }
      last.set(inst.symbol, { h: q.h, l: q.l });
    }
    if (events.length > 300) events.length = 300;
    market.touch("hl-events");
  });
}

/** Streaming alerts for fresh intraday highs / lows across the instrument universe. */
export default function HighLowScanner({ id, settings }: WidgetProps) {
  useEffect(startTracking, []);
  useTopic("hl-events", 500);
  const filter = (settings.filter as "both" | "high" | "low") ?? "both";
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const setSymbol = useWorkspace((s) => s.setSymbol);
  const list = events.filter((e) => filter === "both" || (filter === "high" ? e.type === "HIGH" : e.type === "LOW")).slice(0, 150);
  const highs = events.filter((e) => e.type === "HIGH").length;
  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="flex h-[24px] shrink-0 items-center gap-1 border-b border-line px-1">
        <Seg value={filter} onChange={(v) => updateSettings(id, { filter: v })} options={[{ value: "both", label: "Both" }, { value: "high", label: "Day highs" }, { value: "low", label: "Day lows" }]} />
        <span className="ml-auto text-[10px] text-dim">
          <span className="text-up">{highs} highs</span> · <span className="text-down">{events.length - highs} lows</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="num w-full">
          <thead className="sticky top-0 bg-panel2 text-[10px] text-dim">
            <tr>
              <th className="px-1.5 py-0.5 text-left font-normal">Time</th>
              <th className="px-1 text-left font-normal">Symbol</th>
              <th className="px-1 text-left font-normal">Event</th>
              <th className="px-1 text-right font-normal">Price</th>
              <th className="px-1.5 text-right font-normal">Chg%</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e, i) => (
              <tr key={`${e.t}-${e.s}-${e.type}-${i}`} onClick={() => setSymbol(id, e.s)} className={cx("cursor-pointer border-b border-line/40 hover:bg-panel3", i < 3 && market.simTime - e.t < 3000 && "flash")}>
                <td className="px-1.5 py-[2px] text-muted">{fmtTime(e.t, true)}</td>
                <td className="px-1 font-semibold">{e.s}</td>
                <td className={cx("px-1", e.type === "HIGH" ? "text-up" : "text-down")}>{e.type === "HIGH" ? "▲ New high" : "▼ New low"}</td>
                <td className="px-1 text-right">{e.price.toFixed(2)}</td>
                <td className={cx("px-1.5 text-right", e.chgPct >= 0 ? "text-up" : "text-down")}>{e.chgPct.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="p-3 text-center text-dim">Watching {BASE_INSTRUMENTS.length - 1} instruments for fresh day highs / lows…</div>}
      </div>
    </div>
  );
}
