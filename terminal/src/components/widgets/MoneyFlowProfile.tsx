"use client";
import { useMemo } from "react";
import { useSub, useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { aggregateFlows, flowSeries, fmtCr, type StrikeFlow } from "@/lib/analytics/moneyflow";
import { atmStrike, optionRoot, rootOf } from "@/lib/sim/instruments";
import { fmtTime, istMidnight, sessionOpen, fmtDate } from "@/lib/sim/time";
import { rangeDays, tfMinutes } from "@/lib/data/aggregate";
import { useWorkspace } from "@/lib/state/workspace";
import { Empty, Sel, Seg, cx } from "../ui";
import type { WidgetProps } from "./ChartWidget";

type Mode = "standard" | "range" | "series";

/**
 * Options Money Flow Profile. Per strike: aggressive call/put buying vs selling
 * in ₹ (or lots). Green ↑ = aggressive put selling (bullish), red ↓ = aggressive
 * call selling (bearish); a strike with 3+ burst minutes is highlighted as
 * institutional. Live mode streams; Mark mode pins to the candle marked on a
 * linked chart.
 */
export default function MoneyFlowProfile({ id, symbol, settings, channel }: WidgetProps) {
  const root = rootOf(symbol) && optionRoot(rootOf(symbol)!) ? rootOf(symbol)! : "NIFTY";
  const r = optionRoot(root)!;
  const mode = ((settings.mode as Mode) ?? "standard") as Mode;
  const live = settings.live !== false;
  const rangeMin = Number(settings.rangeMin) || 30;
  const units = settings.units === "lots" ? "lots" : "value";
  const threshold = Number(settings.threshold) || 500;
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const markT = useWorkspace((s) => (channel !== "none" ? s.ws.channels[channel].mark : null));
  const tf = useWorkspace((s) => s.ws.tf);
  const range = useWorkspace((s) => s.ws.range);
  const days = !live && markT && istMidnight(markT) !== istMidnight(market.simTime) ? rangeDays(range) : 1;
  useSub({ kind: "mflow", root, days });
  const v = useTopic(`mflow:${root}`, 1000);
  const set = (p: Record<string, unknown>) => updateSettings(id, p);

  const flows = market.flowList(root);
  const lastT = flows.length ? flows[flows.length - 1].t : 0;
  const pinned = !live && markT !== null;
  const T = pinned ? markT! : lastT;
  const from = mode === "range" ? T - rangeMin * 60_000 : sessionOpen(T);

  const data = useMemo(() => {
    if (!flows.length) return null;
    const agg = aggregateFlows(flows, from, T, r.lotSize);
    // burst minutes per strike in the window (for institutional highlighting)
    const bursts = new Map<number, { bull: number; bear: number }>();
    for (const f of flows) {
      if (f.t < from || f.t > T) continue;
      for (const [k, cb, cs, pb, ps] of f.rows) {
        const b = bursts.get(k) ?? { bull: 0, bear: 0 };
        if (ps - pb >= threshold) b.bull++;
        if (cs - cb >= threshold) b.bear++;
        bursts.set(k, b);
      }
    }
    const spotFlow = [...flows].reverse().find((f) => f.t <= T);
    return { ...agg, bursts, spot: spotFlow?.spot ?? 0 };
  }, [flows, from, T, r.lotSize, threshold, v]); // eslint-disable-line react-hooks/exhaustive-deps

  const series = useMemo(() => (mode === "series" ? flowSeries(flows.filter((f) => f.t >= sessionOpen(T) && f.t <= T), tfMinutes(tf), r.lotSize) : []), [mode, flows, T, tf, r.lotSize, v]); // eslint-disable-line react-hooks/exhaustive-deps

  const val = (s: StrikeFlow, key: "ceBuy" | "ceSell" | "peBuy" | "peSell") => (units === "lots" ? s[key] : s[`${key}Val` as const]);
  const fmt = (x: number) => (units === "lots" ? `${Math.round(x)}` : fmtCr(x));

  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="flex h-[24px] shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1">
        <Seg<Mode> value={mode} onChange={(m) => set({ mode: m })} options={[{ value: "standard", label: "Standard" }, { value: "range", label: "Range" }, { value: "series", label: "Series" }]} />
        {mode === "range" && <Sel value={rangeMin} onChange={(m) => set({ rangeMin: m })} options={[5, 15, 30, 60, 120].map((m) => ({ value: m, label: `last ${m}m` }))} />}
        <Seg value={live ? "live" : "mark"} onChange={(x) => set({ live: x === "live" })} options={[{ value: "live", label: "● Live" }, { value: "mark", label: "⚑ Mark" }]} />
        <Seg value={units} onChange={(x) => set({ units: x })} options={[{ value: "value", label: "₹" }, { value: "lots", label: "Lots" }]} />
        <span className="ml-1 truncate text-[10px] text-dim">
          {root} · {pinned ? `pinned ${fmtDate(T)} ${fmtTime(T)}` : live ? `live ${lastT ? fmtTime(lastT) : ""}` : channel === "none" ? "link a channel & mark a candle" : "mark a candle on a linked chart"}
        </span>
      </div>
      {!data ? (
        <Empty>Loading options flow…</Empty>
      ) : (
        <>
          <div className="num grid shrink-0 grid-cols-3 gap-2 border-b border-line px-2 py-1">
            <div>
              <div className="text-[10px] text-dim">Bullish flow (PE sell + CE buy)</div>
              <div className="text-up">{fmtCr(data.totals.bull)}</div>
            </div>
            <div>
              <div className="text-[10px] text-dim">Bearish flow (CE sell + PE buy)</div>
              <div className="text-down">{fmtCr(data.totals.bear)}</div>
            </div>
            <div>
              <div className="text-[10px] text-dim">Net · bias</div>
              <div className={data.totals.bull >= data.totals.bear ? "text-up" : "text-down"}>
                {fmtCr(data.totals.bull - data.totals.bear)} · {data.totals.bull >= data.totals.bear ? "BULLISH" : "BEARISH"}
              </div>
            </div>
          </div>
          {mode === "series" ? (
            <SeriesChart series={series} />
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <div className="num sticky top-0 z-10 grid grid-cols-[1fr_76px_1fr] bg-panel2 px-1 py-0.5 text-[10px] text-dim">
                <span className="text-right">PE sell ▮ / buy ▮</span>
                <span className="text-center">Strike</span>
                <span>CE buy ▮ / sell ▮</span>
              </div>
              <ProfileRows strikes={data.strikes} bursts={data.bursts} atm={atmStrike(root, data.spot)} val={val} fmt={fmt} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

function ProfileRows({
  strikes,
  bursts,
  atm,
  val,
  fmt,
}: {
  strikes: StrikeFlow[];
  bursts: Map<number, { bull: number; bear: number }>;
  atm: number;
  val: (s: StrikeFlow, k: "ceBuy" | "ceSell" | "peBuy" | "peSell") => number;
  fmt: (x: number) => string;
}) {
  let max = 1;
  for (const s of strikes) max = Math.max(max, val(s, "ceBuy"), val(s, "ceSell"), val(s, "peBuy"), val(s, "peSell"));
  return (
    <div className="num">
      {strikes.map((s) => {
        const b = bursts.get(s.k) ?? { bull: 0, bear: 0 };
        const inst = b.bull >= 3 || b.bear >= 3;
        return (
          <div key={s.k} className={cx("grid grid-cols-[1fr_76px_1fr] items-center border-b border-line/50 px-1 py-[1px]", s.k === atm && "bg-accent/10", inst && "bg-warn/10")}>
            <div className="flex flex-col items-end gap-[1px]">
              <Bar v={val(s, "peSell")} max={max} color="bg-up" label={fmt(val(s, "peSell"))} dir="left" />
              <Bar v={val(s, "peBuy")} max={max} color="bg-down/80" label={fmt(val(s, "peBuy"))} dir="left" />
            </div>
            <div className="flex items-center justify-center gap-1 text-[11px]">
              {b.bull > 0 && <span className="text-up" title={`${b.bull} put-selling burst minute(s)`}>{"↑".repeat(Math.min(3, b.bull))}</span>}
              <span className={cx(s.k === atm ? "font-bold text-[#9ec5ff]" : "text-fg")}>{s.k}</span>
              {b.bear > 0 && <span className="text-down" title={`${b.bear} call-selling burst minute(s)`}>{"↓".repeat(Math.min(3, b.bear))}</span>}
            </div>
            <div className="flex flex-col items-start gap-[1px]">
              <Bar v={val(s, "ceBuy")} max={max} color="bg-up" label={fmt(val(s, "ceBuy"))} dir="right" />
              <Bar v={val(s, "ceSell")} max={max} color="bg-down/80" label={fmt(val(s, "ceSell"))} dir="right" />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Bar({ v, max, color, label, dir }: { v: number; max: number; color: string; label: string; dir: "left" | "right" }) {
  const pct = Math.max(1, (v / max) * 100);
  return (
    <div className={cx("flex h-[8px] w-full items-center gap-1", dir === "left" ? "flex-row-reverse" : "")}>
      <div className={cx("h-full rounded-[1px]", color)} style={{ width: `${pct * 0.78}%` }} />
      <span className="text-[9px] leading-none text-muted">{label}</span>
    </div>
  );
}

function SeriesChart({ series }: { series: { t: number; bull: number; bear: number }[] }) {
  const data = series.slice(-80);
  if (!data.length) return <Empty>No flow yet</Empty>;
  const max = Math.max(1, ...data.map((d) => Math.max(d.bull, d.bear)));
  const W = 1000;
  const H = 300;
  const bw = W / data.length;
  let cum = 0;
  const cumPts = data.map((d, i) => {
    cum += d.bull - d.bear;
    return { x: i * bw + bw / 2, c: cum };
  });
  const cmax = Math.max(1, ...cumPts.map((p) => Math.abs(p.c)));
  return (
    <div className="relative min-h-0 flex-1 p-1">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
        <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#1f2733" />
        {data.map((d, i) => (
          <g key={d.t}>
            <rect x={i * bw + bw * 0.15} width={bw * 0.7} y={H / 2 - (d.bull / max) * (H / 2 - 10)} height={(d.bull / max) * (H / 2 - 10)} fill="#22c55e" opacity="0.8" />
            <rect x={i * bw + bw * 0.15} width={bw * 0.7} y={H / 2} height={(d.bear / max) * (H / 2 - 10)} fill="#ef4444" opacity="0.8" />
          </g>
        ))}
        <polyline fill="none" stroke="#eab308" strokeWidth="2" vectorEffect="non-scaling-stroke" points={cumPts.map((p) => `${p.x},${H / 2 - (p.c / cmax) * (H / 2 - 12)}`).join(" ")} />
      </svg>
      <div className="num pointer-events-none absolute top-1 left-2 text-[10px] text-dim">
        bullish ₹ ↑ · bearish ₹ ↓ per bar · <span className="text-warn">cumulative net</span> · {fmtTime(data[0].t)}–{fmtTime(data[data.length - 1].t)}
      </div>
    </div>
  );
}
