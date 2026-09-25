"use client";
import { useEffect, useRef, useState } from "react";
import { useSub } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { rangeDays } from "@/lib/data/aggregate";
import { getInstrument } from "@/lib/sim/instruments";
import { sessionOpen, fmtTime } from "@/lib/sim/time";
import type { TpoProfile } from "@/lib/analytics/tpo";
import { useWorkspace } from "@/lib/state/workspace";
import { TpoChartEngine } from "../chart/TpoChartEngine";
import { Btn, Empty, Sel, Seg, useSize } from "../ui";
import type { WidgetProps } from "./ChartWidget";

export function TpoView({ id, symbol, settings }: WidgetProps) {
  const range = useWorkspace((s) => s.ws.range);
  const days = rangeDays(range);
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const inst = getInstrument(symbol);
  const [selected, setSelected] = useState<number[]>([]);
  const [splitMode, setSplitMode] = useState(false);
  const [profiles, setProfiles] = useState<TpoProfile[]>([]);
  useSub({ kind: "bars", symbol, days });
  const period = Number(settings.tpoPeriod) || 30;
  const mode: "letters" | "blocks" = settings.tpoMode === "blocks" ? "blocks" : "letters";
  const rowSetting = (settings.tpoRow as string) ?? "auto";
  const merges = (settings.tpoMerges as number[]) ?? [];
  const splits = (settings.tpoSplits as number[]) ?? [];

  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<TpoChartEngine | null>(null);
  const latest = useRef({ period, mode, rowSetting, merges, splits, selected, splitMode, symbol });
  latest.current = { period, mode, rowSetting, merges, splits, selected, splitMode, symbol };

  const push = () => {
    const e = engineRef.current;
    const L = latest.current;
    const ins = market.instrument(L.symbol);
    if (!e || !ins) return;
    e.setInputs({
      bars: market.getBars(L.symbol),
      inst: ins,
      periodMin: L.period,
      row: L.rowSetting === "auto" ? "auto" : Number(L.rowSetting) * ins.tickSize,
      mode: L.mode,
      merges: L.merges,
      splits: L.splits,
      selected: L.selected,
      splitMode: L.splitMode,
    });
  };

  useEffect(() => {
    const e = new TpoChartEngine(canvasRef.current!);
    engineRef.current = e;
    return () => {
      e.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setCallbacks({
      onSelect: setSelected,
      onSplit: (t) => {
        updateSettings(id, { tpoSplits: [...new Set([...latest.current.splits, t])].sort((a, b) => a - b) });
        setSplitMode(false);
      },
      onProfiles: setProfiles,
    });
  }, [id, updateSettings]);

  useEffect(() => {
    if (size.w > 0) engineRef.current?.resize(size.w, size.h, window.devicePixelRatio || 1);
  }, [size.w, size.h]);
  useEffect(() => market.subscribe(`bars:${symbol}`, push), [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(push);

  const sel = profiles.filter((p) => selected.includes(p.start)).sort((a, b) => a.start - b.start);
  const contiguous = sel.length >= 2 && sel.every((p, i) => i === 0 || profiles.indexOf(p) === profiles.indexOf(sel[i - 1]) + 1);

  const merge = () => {
    if (!contiguous) return;
    const inner = sel.slice(1).map((p) => p.start);
    const nextMerges = new Set(merges);
    let nextSplits = splits.slice();
    for (const b of inner) {
      if (nextSplits.includes(b)) nextSplits = nextSplits.filter((x) => x !== b);
      if (b === sessionOpen(b)) nextMerges.add(b);
    }
    updateSettings(id, { tpoMerges: [...nextMerges], tpoSplits: nextSplits });
    setSelected([sel[0].start]);
  };

  if (!inst) return <Empty>Unknown symbol</Empty>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[24px] shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1">
        <Sel value={period} onChange={(v) => updateSettings(id, { tpoPeriod: v })} title="TPO period" options={[15, 30, 60].map((v) => ({ value: v, label: `${v}m periods` }))} />
        <Seg value={mode} onChange={(v) => updateSettings(id, { tpoMode: v })} options={[{ value: "letters", label: "Letters" }, { value: "blocks", label: "Blocks" }]} />
        <Sel
          value={rowSetting}
          onChange={(v) => updateSettings(id, { tpoRow: v })}
          title="Row size"
          options={[{ value: "auto", label: "Row: auto" }, ...["20", "40", "50", "100", "200", "400"].map((v) => ({ value: v, label: `${v} ticks` }))]}
        />
        <div className="mx-0.5 h-3.5 w-px bg-line" />
        <Btn active={splitMode} onClick={() => setSplitMode((x) => !x)} title="Split mode: click a letter to split the profile at that period">
          ✂ Split
        </Btn>
        <Btn disabled={!contiguous} onClick={merge} title="Merge the selected adjacent profiles (shift-click to multi-select)">
          ⊕ Merge{sel.length > 1 ? ` ${sel.length}` : ""}
        </Btn>
        <Btn
          disabled={!merges.length && !splits.length}
          onClick={() => {
            updateSettings(id, { tpoMerges: [], tpoSplits: [] });
            setSelected([]);
          }}
          title="Back to one profile per session"
        >
          Reset
        </Btn>
        <div className="flex-1" />
        {sel.length === 1 && (
          <span className="num truncate text-[10px] text-muted">
            {fmtTime(sel[0].start)}–{fmtTime(sel[0].end)} POC {sel[0].poc} · VA {sel[0].val}–{sel[0].vah} · singles {sel[0].singles.length}
          </span>
        )}
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0" />
      </div>
    </div>
  );
}
