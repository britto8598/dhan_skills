"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSub, useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { aggregate, rangeDays, tfMinutes } from "@/lib/data/aggregate";
import { flowArrows } from "@/lib/analytics/moneyflow";
import { getInstrument, optionRoot, rootOf } from "@/lib/sim/instruments";
import { emit, on } from "@/lib/state/sync";
import { newId, useWorkspace, type Channel, type Drawing } from "@/lib/state/workspace";
import { PriceChartEngine, type ChartSettings, type Tool } from "../chart/PriceChartEngine";
import { C } from "../chart/theme";
import { Btn, Check, Empty, Menu, MenuLabel, Sel, Seg, TextInput, useSize } from "../ui";
import { TfSelect } from "../shell/TopBar";
import { ScalperHud, ScalperInputs } from "./ScalperPanel";
import { useScalper } from "./useScalper";
import { TpoView } from "./TpoView";

export interface WidgetProps {
  id: string;
  symbol: string;
  settings: Record<string, unknown>;
  channel: Channel;
}

const DRAW_COLORS: Record<string, string> = { trend: "#60a5fa", hline: "#f472b6", vprofile: "#facc15" };

export default function ChartWidget(props: WidgetProps) {
  const type = (props.settings.chartType as string) ?? "candles";
  if (type === "tpo") return <TpoView {...props} />;
  return <PriceChartView {...props} />;
}

function useChartTf(settings: Record<string, unknown>): string {
  const global = useWorkspace((s) => s.ws.tf);
  const tf = (settings.tf as string) ?? "global";
  return tf === "global" ? global : tf;
}

function PriceChartView({ id, symbol, settings, channel }: WidgetProps) {
  const s = settings as Record<string, unknown> & { chartType: string };
  const tf = useChartTf(settings);
  const tfMin = tfMinutes(tf);
  const range = useWorkspace((st) => st.ws.range);
  const days = rangeDays(range);
  const drawings = useWorkspace((st) => st.ws.drawings[symbol]) ?? EMPTY_DRAWINGS;
  const mark = useWorkspace((st) => (channel !== "none" ? st.ws.channels[channel].mark : ((st.ws.widgets[id]?.settings.localMark as number | null) ?? null)));
  const scalperCfg = useWorkspace((st) => st.ws.scalper);
  const { updateSettings, addDrawing, updateDrawing, removeDrawing, clearDrawings, setMark } = useWorkspace.getState();
  const [tool, setTool] = useState<Tool>("none");
  const [inputsOpen, setInputsOpen] = useState(false);
  const inst = getInstrument(symbol);
  const root = rootOf(symbol);
  const hasOptions = !!(root && optionRoot(root)) && inst?.kind !== "OPT" && inst?.kind !== "EQ";

  useSub({ kind: "bars", symbol, days });
  const mfOn = !!s.mfArrows && hasOptions;
  useSub(mfOn ? { kind: "mflow", root: root!, days } : null);
  const mfV = useTopic(mfOn ? `mflow:${root}` : null, 1000);
  const arrows = useMemo(() => (mfOn ? flowArrows(market.flowList(root!), tfMin, Number(s.mfThreshold) || 500) : null), [mfOn, root, tfMin, s.mfThreshold, mfV]); // eslint-disable-line react-hooks/exhaustive-deps

  const scalper = useScalper(!!s.scalper, symbol, scalperCfg, tfMin, days);

  const chartSettings: ChartSettings = {
    mode: s.chartType === "footprint" ? "footprint" : "candles",
    volume: !!s.volume,
    deltaPane: !!s.deltaPane,
    cvd: !!s.cvd,
    bell: !!s.bell,
    intensity: !!s.intensity,
    stats: !!s.stats,
    vwap: !!s.vwap,
    divergence: !!s.divergence,
    divThreshold: Number(s.divThreshold) || 100,
    fpTicks: String(s.fpTicks ?? "auto"),
    fpRatio: Number(s.fpRatio) || 3,
    fpMode: s.fpMode === "horizontal" ? "horizontal" : "diagonal",
    fpDisplay: (s.fpDisplay as ChartSettings["fpDisplay"]) ?? "bidask",
    units: s.units === "qty" ? "qty" : "lots",
    optionMode: scalperCfg.optionMode,
  };

  // ---- engine wiring (data flows straight from the store to the canvas, no React re-render per tick)
  const [wrapRef, size] = useSize<HTMLDivElement>();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PriceChartEngine | null>(null);
  const latest = useRef({ chartSettings, drawings, mark, arrows, scalper, tfMin, symbol });
  latest.current = { chartSettings, drawings, mark, arrows, scalper, tfMin, symbol };

  const push = () => {
    const e = engineRef.current;
    const L = latest.current;
    const ins = getInstrument(L.symbol);
    if (!e || !ins) return;
    const src = market.getBars(L.symbol);
    e.setInputs({
      bars: aggregate(L.symbol, src, L.tfMin),
      inst: market.instrument(L.symbol) ?? ins,
      tfMin: L.tfMin,
      settings: L.chartSettings,
      levels: L.scalper.levels,
      series: L.scalper.series,
      options: L.scalper.options,
      arrows: L.arrows,
      drawings: L.drawings,
      markT: L.mark,
      loading: !market.bars.has(L.symbol),
    });
  };

  useEffect(() => {
    const c = canvasRef.current!;
    const e = new PriceChartEngine(c);
    engineRef.current = e;
    return () => {
      e.destroy();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setCallbacks({
      onBarClick: (t) => {
        if (tool !== "mark") return;
        if (channel !== "none") setMark(channel, t);
        else updateSettings(id, { localMark: t });
        emit("mark", { channel, t });
        setTool("none");
      },
      onCrosshair: (t) => emit("crosshair", { channel, t, from: id }),
      onAddDrawing: (d) => addDrawing(symbol, { ...d, id: newId("d"), color: DRAW_COLORS[d.kind] ?? C.accent } as Drawing),
      onUpdateDrawing: (did, p) => updateDrawing(symbol, did, p),
      onRemoveDrawing: (did) => removeDrawing(symbol, did),
      onToolDone: () => setTool("none"),
    });
    engineRef.current?.setTool(tool);
  }, [tool, channel, id, symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (size.w > 0) engineRef.current?.resize(size.w, size.h, window.devicePixelRatio || 1);
  }, [size.w, size.h]);

  useEffect(() => market.subscribe(`bars:${symbol}`, push), [symbol]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(push); // settings / drawings / overlays changed

  useEffect(
    () =>
      on("crosshair", (data) => {
        const d = data as { channel: Channel; t: number | null; from: string };
        if (d.from === id || channel === "none" || d.channel !== channel) return;
        engineRef.current?.setExternalCrosshair(d.t);
      }),
    [id, channel],
  );

  const set = (p: Record<string, unknown>) => updateSettings(id, p);
  const hudPos = (s.hudPos as { x: number; y: number }) ?? { x: 74, y: 6 };
  const isFp = s.chartType === "footprint";

  if (!inst) return <Empty>Unknown symbol {symbol}</Empty>;
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[24px] shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-1">
        <TfSelect value={(s.tf as string) ?? "global"} onChange={(v) => set({ tf: v })} />
        <div className="mx-0.5 h-3.5 w-px bg-line" />
        <Btn active={tool === "trend"} onClick={() => setTool(tool === "trend" ? "none" : "trend")} title="Trendline (drag)">
          ╱
        </Btn>
        <Btn active={tool === "hline"} onClick={() => setTool(tool === "hline" ? "none" : "hline")} title="Horizontal support/resistance (click)">
          ―
        </Btn>
        <Btn active={tool === "vprofile"} onClick={() => setTool(tool === "vprofile" ? "none" : "vprofile")} title="Fixed-range volume profile (drag across bars)">
          ▤
        </Btn>
        <Btn active={tool === "mark"} onClick={() => setTool(tool === "mark" ? "none" : "mark")} title="Mark mode: click a candle to pin Money Flow to that time">
          ⚑ Mark
        </Btn>
        {mark !== null && (
          <Btn
            onClick={() => {
              if (channel !== "none") setMark(channel, null);
              else set({ localMark: null });
            }}
            title="Clear mark (back to live)"
          >
            ✕ mark
          </Btn>
        )}
        {drawings.length > 0 && (
          <Btn onClick={() => clearDrawings(symbol)} title="Remove all drawings on this symbol" danger>
            ⌫ {drawings.length}
          </Btn>
        )}
        <div className="mx-0.5 h-3.5 w-px bg-line" />
        <Menu trigger={<>ƒx Indicators</>} width={250} title="Indicators & overlays">
          <MenuLabel>Panes</MenuLabel>
          <div className="px-2">
            <Check checked={!!s.volume} onChange={(v) => set({ volume: v })} label="Volume" />
            <Check checked={!!s.deltaPane} onChange={(v) => set({ deltaPane: v })} label="Delta histogram" />
            <Check checked={!!s.cvd} onChange={(v) => set({ cvd: v })} label="Cumulative delta (CVD)" />
            <Check checked={!!s.bell} onChange={(v) => set({ bell: v })} label="Total Bell aggregated volume" />
            <Check checked={!!s.intensity} onChange={(v) => set({ intensity: v })} label="Market activity intensity" />
            <Check checked={!!s.stats} onChange={(v) => set({ stats: v })} label="Bar statistics table" />
          </div>
          <MenuLabel>Overlays</MenuLabel>
          <div className="px-2">
            <Check checked={!!s.vwap} onChange={(v) => set({ vwap: v })} label="VWAP ± SD bands" />
            <div className="flex items-center gap-2">
              <Check checked={!!s.divergence} onChange={(v) => set({ divergence: v })} label="Delta divergence ±" />
              <TextInput type="number" value={Number(s.divThreshold) || 100} onChange={(e) => set({ divThreshold: Number(e.target.value) || 0 })} className="h-[20px] w-[64px]" title="Divergence threshold (lots)" />
            </div>
            <div className="flex items-center gap-2">
              <Check checked={!!s.mfArrows} onChange={(v) => set({ mfArrows: v })} label="Options flow arrows ≥" title="Green ↑ = aggressive put selling, red ↓ = aggressive call selling; 3+ stacked = institutional" />
              <TextInput type="number" value={Number(s.mfThreshold) || 500} onChange={(e) => set({ mfThreshold: Number(e.target.value) || 0 })} className="h-[20px] w-[64px]" title="Net lots per strike" />
            </div>
            {!hasOptions && !!s.mfArrows && <div className="text-[10px] text-dim">Flow arrows need an index / index-future chart.</div>}
            <div className="flex items-center gap-2">
              <Check checked={!!s.scalper} onChange={(v) => set({ scalper: v })} label="Scalper: synthetic, BEP, HUD" />
              <Btn onClick={() => setInputsOpen(true)}>Inputs…</Btn>
            </div>
          </div>
          <MenuLabel>Units</MenuLabel>
          <div className="px-2 pb-1">
            <Seg value={chartSettings.units} onChange={(v) => set({ units: v })} options={[{ value: "lots", label: "Lots" }, { value: "qty", label: "Shares / contracts" }]} />
          </div>
        </Menu>
        {isFp && (
          <Menu trigger={<>▦ Footprint</>} width={240} title="Footprint settings">
            <div className="flex flex-col gap-2 p-2 text-[11px]">
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted">Row size</span>
                <Sel
                  value={String(s.fpTicks ?? "auto")}
                  onChange={(v) => set({ fpTicks: v })}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "10", label: "10 ticks" },
                    { value: "20", label: "20 ticks" },
                    { value: "40", label: "40 ticks" },
                    { value: "50", label: "50 ticks" },
                    { value: "100", label: "100 ticks" },
                    { value: "200", label: "200 ticks" },
                  ]}
                />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted">Imbalance ratio %</span>
                <TextInput type="number" value={Math.round((Number(s.fpRatio) || 3) * 100)} onChange={(e) => set({ fpRatio: Math.max(1.1, (Number(e.target.value) || 300) / 100) })} className="h-[20px] w-[70px]" />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted">Compare</span>
                <Seg value={chartSettings.fpMode} onChange={(v) => set({ fpMode: v })} options={[{ value: "diagonal", label: "Diagonal" }, { value: "horizontal", label: "Same row" }]} />
              </label>
              <label className="flex items-center justify-between gap-2">
                <span className="text-muted">Cells</span>
                <Seg value={chartSettings.fpDisplay} onChange={(v) => set({ fpDisplay: v })} options={[{ value: "bidask", label: "Bid×Ask" }, { value: "delta", label: "Delta" }, { value: "volume", label: "Vol" }]} />
              </label>
              <div className="text-[10px] leading-snug text-dim">Volume is estimated from snapshot feeds (NSE retail APIs are not tick-by-tick). Zoom in (wheel) to see numbers.</div>
            </div>
          </Menu>
        )}
        <div className="flex-1" />
        <Btn onClick={() => engineRef.current?.resetView()} title="Reset zoom / auto-scale (or double-click the chart)">
          ⟲
        </Btn>
      </div>
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        <canvas ref={canvasRef} className="absolute inset-0 outline-none" />
        {scalper.mismatch && (
          <div className="absolute top-8 left-2 rounded border border-line bg-panel2/90 px-2 py-1 text-[10px] text-muted">
            Scalper inputs are set for {scalperCfg.root}.{" "}
            <button type="button" className="text-accent underline" onClick={() => useWorkspace.getState().setScalper({ root: scalper.mismatch!, baseStrike: 0, expiry: "", offset: optionRoot(scalper.mismatch!)?.strikeStep ?? 50 })}>
              Use {scalper.mismatch}
            </button>
          </div>
        )}
        {!!s.scalper && scalper.hud && scalperCfg.showHud && (
          <ScalperHud hud={scalper.hud} cfg={scalperCfg} pos={hudPos} onMove={(p) => set({ hudPos: p })} onEdit={() => setInputsOpen(true)} />
        )}
        {tool !== "none" && (
          <div className="pointer-events-none absolute bottom-6 left-2 rounded bg-accent/20 px-2 py-0.5 text-[10px] text-[#bfdbfe]">
            {tool === "mark" ? "Click a candle to mark it" : tool === "hline" ? "Click to place a level" : "Drag to draw · Esc cancels · Del removes selected"}
          </div>
        )}
      </div>
      {inputsOpen && <ScalperInputs onClose={() => setInputsOpen(false)} chartRoot={root} />}
    </div>
  );
}

const EMPTY_DRAWINGS: Drawing[] = [];
