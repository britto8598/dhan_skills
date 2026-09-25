"use client";
import { memo, Suspense } from "react";
import { useWorkspace, useWidget, useWidgetSymbol, WIDGET_LABELS, type Channel, type Screen } from "@/lib/state/workspace";
import { liveScreens, openScreen } from "@/lib/state/sync";
import { CHANNEL_COLORS } from "../chart/theme";
import { Menu, MenuItem, MenuLabel, Seg, cx } from "../ui";
import { SymbolSearch } from "./SymbolSearch";
import { WIDGETS } from "../widgets/registry";

const NEEDS_SYMBOL = new Set(["chart", "orderflow", "moneyflow", "chain", "dom"]);

function ChannelPicker({ value, onChange }: { value: Channel; onChange: (c: Channel) => void }) {
  return (
    <Menu
      trigger={<span className="inline-block h-2.5 w-2.5 rounded-[2px] ring-1 ring-white/20" style={{ background: CHANNEL_COLORS[value] }} />}
      title={`Link channel: ${value}`}
      width={140}
      align="right"
    >
      {(close) => (
        <>
          <MenuLabel>Symbol link</MenuLabel>
          {(["red", "blue", "yellow", "none"] as Channel[]).map((c) => (
            <MenuItem
              key={c}
              active={c === value}
              onClick={() => {
                onChange(c);
                close();
              }}
            >
              <span className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: CHANNEL_COLORS[c] }} />
                {c === "none" ? "None (unlinked)" : c[0].toUpperCase() + c.slice(1)}
              </span>
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

function WidgetFrameInner({ id, screen }: { id: string; screen: Screen }) {
  const w = useWidget(id);
  const symbol = useWidgetSymbol(id);
  const { setSymbol, setChannel, removeWidget, popout, setFloat, updateSettings } = useWorkspace.getState();
  if (!w) return null;
  const Comp = WIDGETS[w.type];
  const chartType = (w.settings.chartType as string) ?? "candles";
  return (
    <div className={cx("flex h-full w-full flex-col overflow-hidden border-r border-b border-line bg-panel", w.float && "rounded border border-line2 shadow-2xl shadow-black/70")}>
      <div className="flex h-[26px] shrink-0 items-center gap-1 border-b border-line bg-panel2 pr-1 pl-0.5">
        <div className={cx("drag-handle flex h-full cursor-move items-center gap-1 px-1 text-dim select-none hover:text-fg", w.float && "float-handle")} title="Drag to move">
          <span className="text-[11px]">⋮⋮</span>
          <span className="max-w-[120px] truncate text-[10px] tracking-wide text-muted uppercase">{WIDGET_LABELS[w.type]}</span>
        </div>
        {NEEDS_SYMBOL.has(w.type) && <SymbolSearch value={symbol} onChange={(s) => setSymbol(id, s)} />}
        {w.type === "chart" && (
          <Seg
            value={chartType}
            onChange={(v) => updateSettings(id, { chartType: v })}
            options={[
              { value: "candles", label: "Candles", title: "Candlestick chart" },
              { value: "footprint", label: "Footprint", title: "Bid × Ask footprint" },
              { value: "tpo", label: "TPO", title: "Market profile" },
            ]}
          />
        )}
        <div className="flex-1 drag-handle self-stretch" />
        <ChannelPicker value={w.channel} onChange={(c) => setChannel(id, c)} />
        <button
          type="button"
          title={w.float ? "Dock into grid" : "Float over the workspace"}
          onClick={() => setFloat(id, w.float ? null : { x: 120 + Math.random() * 80, y: 90 + Math.random() * 60, w: 560, h: 380 })}
          className="no-drag h-[20px] rounded-[3px] px-1 text-[12px] text-muted hover:bg-panel3 hover:text-fg"
        >
          {w.float ? "⇲" : "⇱"}
        </button>
        <Menu trigger={<span className="text-[12px]">⧉</span>} title="Pop out to another screen" width={170} align="right">
          {(close) => (
            <>
              <MenuLabel>Move to</MenuLabel>
              {([0, 1, 2] as Screen[]).map((s) => (
                <MenuItem
                  key={s}
                  active={w.screen === s}
                  hint={s > 0 && !liveScreens().includes(s) ? "opens window" : undefined}
                  onClick={() => {
                    popout(id, s);
                    if (s > 0 && screen === 0) openScreen(s as 1 | 2);
                    close();
                  }}
                >
                  {s === 0 ? "Main window" : `Screen ${s}`}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <button type="button" title="Close widget" onClick={() => removeWidget(id)} className="no-drag h-[20px] rounded-[3px] px-1 text-[11px] text-muted hover:bg-down/20 hover:text-down">
          ✕
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={null}>
          <Comp id={id} symbol={symbol} settings={w.settings} channel={w.channel} />
        </Suspense>
      </div>
    </div>
  );
}

export const WidgetFrame = memo(WidgetFrameInner);
