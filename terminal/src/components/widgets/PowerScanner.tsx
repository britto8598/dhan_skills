"use client";
import { useRef } from "react";
import { useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import type { Quote } from "@/lib/feed/protocol";
import { BASE_INSTRUMENTS } from "@/lib/sim/instruments";
import { fmtTime } from "@/lib/sim/time";
import { useWorkspace } from "@/lib/state/workspace";
import { fmtNum } from "../chart/theme";
import { Btn, Menu, MenuItem, Sel, Seg, TextInput, cx } from "../ui";
import type { WidgetProps } from "./ChartWidget";

export type Metric = "volLots" | "deltaLots" | "deltaPct" | "surge" | "chgPct" | "imb" | "oiChgPct" | "rangePos";
type Op = ">" | "<" | ">=" | "<=";
export interface Rule {
  metric: Metric;
  op: Op;
  value: number;
}

const METRICS: { value: Metric; label: string }[] = [
  { value: "volLots", label: "Volume (lots, last 1m)" },
  { value: "deltaLots", label: "Delta (lots, last 1m)" },
  { value: "deltaPct", label: "Delta % of volume" },
  { value: "surge", label: "Volume surge × avg" },
  { value: "chgPct", label: "Change % (day)" },
  { value: "imb", label: "Stacked imbalance score" },
  { value: "oiChgPct", label: "OI change % (futures)" },
  { value: "rangePos", label: "Position in day range %" },
];

const PRESETS: { name: string; combinator: "AND" | "OR"; rules: Rule[] }[] = [
  { name: "Volume surge + buying", combinator: "AND", rules: [{ metric: "surge", op: ">", value: 2 }, { metric: "deltaPct", op: ">", value: 15 }] },
  { name: "Heavy selling delta", combinator: "AND", rules: [{ metric: "deltaLots", op: "<", value: -300 }, { metric: "volLots", op: ">", value: 500 }] },
  { name: "Imbalance stacks", combinator: "OR", rules: [{ metric: "imb", op: ">=", value: 2 }, { metric: "imb", op: "<=", value: -2 }] },
  { name: "Breakout near high", combinator: "AND", rules: [{ metric: "rangePos", op: ">", value: 90 }, { metric: "surge", op: ">", value: 1.5 }] },
  { name: "Volume > 1000 AND Delta > +300", combinator: "AND", rules: [{ metric: "volLots", op: ">", value: 1000 }, { metric: "deltaLots", op: ">", value: 300 }] },
];

export function metricValue(q: Quote, lot: number, m: Metric): number {
  switch (m) {
    case "volLots":
      return q.bv / lot;
    case "deltaLots":
      return q.bd / lot;
    case "deltaPct":
      return q.bv ? (q.bd / q.bv) * 100 : 0;
    case "surge":
      return q.avgBv ? q.bv / q.avgBv : 0;
    case "chgPct":
      return q.pc ? ((q.ltp - q.pc) / q.pc) * 100 : 0;
    case "imb":
      return q.imb;
    case "oiChgPct":
      return q.oi && q.oiChg !== undefined ? (q.oiChg / Math.max(1, q.oi - q.oiChg)) * 100 : 0;
    case "rangePos":
      return q.h > q.l ? ((q.ltp - q.l) / (q.h - q.l)) * 100 : 50;
  }
}

function test(v: number, op: Op, x: number): boolean {
  return op === ">" ? v > x : op === "<" ? v < x : op === ">=" ? v >= x : v <= x;
}

const UNIVERSE = BASE_INSTRUMENTS.filter((i) => i.kind === "FUT" || i.kind === "EQ");

/** Real-time order-flow scanner with a rule builder (e.g. Volume > 1000 lots AND Delta > +300). */
export default function PowerScanner({ id, settings, channel }: WidgetProps) {
  useTopic("quotes", 1000);
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const setSymbol = useWorkspace((s) => s.setSymbol);
  const rules = (settings.rules as Rule[]) ?? [];
  const combinator = (settings.combinator as "AND" | "OR") ?? "AND";
  const firstSeen = useRef(new Map<string, number>());
  const log = useRef<{ t: number; s: string }[]>([]);
  const set = (p: Record<string, unknown>) => updateSettings(id, p);

  const rows = UNIVERSE.map((inst) => {
    const q = market.quotes.get(inst.symbol);
    if (!q) return null;
    const vals = Object.fromEntries(METRICS.map((m) => [m.value, metricValue(q, inst.lotSize, m.value)])) as Record<Metric, number>;
    const res = rules.map((r) => test(vals[r.metric], r.op, r.value));
    const match = rules.length > 0 && (combinator === "AND" ? res.every(Boolean) : res.some(Boolean));
    return { inst, q, vals, match };
  }).filter((r): r is NonNullable<typeof r> => !!r);

  const now = market.simTime;
  for (const r of market.ready ? rows : []) {
    if (r.match && !firstSeen.current.has(r.inst.symbol)) {
      firstSeen.current.set(r.inst.symbol, now);
      log.current.unshift({ t: now, s: r.inst.symbol });
      log.current = log.current.slice(0, 40);
    } else if (!r.match) firstSeen.current.delete(r.inst.symbol);
  }
  const matches = rows.filter((r) => r.match).sort((a, b) => Math.abs(b.vals.surge) - Math.abs(a.vals.surge));

  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="shrink-0 border-b border-line p-1">
        <div className="flex items-center gap-1 pb-1">
          <Seg value={combinator} onChange={(v) => set({ combinator: v })} options={[{ value: "AND", label: "AND" }, { value: "OR", label: "OR" }]} />
          <Btn onClick={() => set({ rules: [...rules, { metric: "surge", op: ">", value: 2 }] })}>＋ Rule</Btn>
          <Menu trigger={<>Presets</>} width={230}>
            {(close) =>
              PRESETS.map((p) => (
                <MenuItem
                  key={p.name}
                  onClick={() => {
                    set({ rules: p.rules, combinator: p.combinator });
                    close();
                  }}
                >
                  {p.name}
                </MenuItem>
              ))
            }
          </Menu>
          <span className="ml-auto text-[10px] text-dim">
            {matches.length}/{rows.length} match · {UNIVERSE.length} futures & stocks
          </span>
        </div>
        {rules.map((r, i) => (
          <div key={i} className="flex items-center gap-1 py-[1px]">
            <span className="w-7 text-center text-[10px] text-dim">{i === 0 ? "IF" : combinator}</span>
            <Sel value={r.metric} onChange={(v) => set({ rules: rules.map((x, k) => (k === i ? { ...x, metric: v } : x)) })} options={METRICS} />
            <Sel value={r.op} onChange={(v) => set({ rules: rules.map((x, k) => (k === i ? { ...x, op: v } : x)) })} options={([">", "<", ">=", "<="] as Op[]).map((o) => ({ value: o, label: o }))} />
            <TextInput type="number" value={r.value} onChange={(e) => set({ rules: rules.map((x, k) => (k === i ? { ...x, value: Number(e.target.value) } : x)) })} className="h-[20px] w-[80px]" />
            <button type="button" className="px-1 text-dim hover:text-down" onClick={() => set({ rules: rules.filter((_, k) => k !== i) })}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="num w-full text-right">
          <thead className="sticky top-0 bg-panel2 text-[10px] text-dim">
            <tr>
              <th className="px-1.5 py-0.5 text-left font-normal">Symbol</th>
              <th className="px-1 font-normal">LTP</th>
              <th className="px-1 font-normal">Chg%</th>
              <th className="px-1 font-normal">Vol</th>
              <th className="px-1 font-normal">Δ</th>
              <th className="px-1 font-normal">Δ%</th>
              <th className="px-1 font-normal">Surge</th>
              <th className="px-1 font-normal">Imb</th>
              <th className="px-1.5 font-normal">Since</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((r) => {
              const t = firstSeen.current.get(r.inst.symbol) ?? now;
              const fresh = now - t < 5000;
              return (
                <tr key={r.inst.symbol} className={cx("cursor-pointer border-b border-line/50 hover:bg-panel3", fresh && "flash")} onClick={() => setSymbol(id, r.inst.symbol)} title={channel === "none" ? "Set a link channel to send clicks to charts" : `Link to ${channel} channel`}>
                  <td className="px-1.5 py-[2px] text-left font-semibold">{r.inst.symbol}</td>
                  <td className="px-1">{r.q.ltp.toFixed(2)}</td>
                  <td className={cx("px-1", r.vals.chgPct >= 0 ? "text-up" : "text-down")}>{r.vals.chgPct.toFixed(2)}</td>
                  <td className="px-1">{fmtNum(r.vals.volLots)}</td>
                  <td className={cx("px-1", r.vals.deltaLots >= 0 ? "text-up" : "text-down")}>{fmtNum(r.vals.deltaLots)}</td>
                  <td className="px-1">{r.vals.deltaPct.toFixed(0)}</td>
                  <td className={cx("px-1", r.vals.surge >= 2 && "text-warn")}>{r.vals.surge.toFixed(1)}×</td>
                  <td className={cx("px-1", r.vals.imb > 0 ? "text-up" : r.vals.imb < 0 ? "text-down" : "")}>{r.vals.imb}</td>
                  <td className="px-1.5 text-muted">{fmtTime(t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!matches.length && <div className="p-3 text-center text-dim">No instruments match the rules right now.</div>}
        {log.current.length > 0 && (
          <div className="border-t border-line px-2 py-1">
            <div className="text-[10px] text-dim uppercase">Trigger log</div>
            <div className="num flex flex-wrap gap-x-3 text-[10px] text-muted">
              {log.current.slice(0, 20).map((l, i) => (
                <span key={i}>
                  {fmtTime(l.t)} <span className="text-fg">{l.s}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
