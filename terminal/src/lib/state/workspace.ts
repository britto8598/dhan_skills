"use client";
/**
 * Workspace state: widgets, grid layouts per screen, symbol-link channels,
 * drawings, global timeframe/range, ticker tape, scalper inputs and saved
 * workspaces. Persisted to localStorage and mirrored across windows by sync.ts.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { defaultScalper, type ScalperConfig } from "../analytics/scalper";

export type Channel = "red" | "blue" | "yellow" | "none";
export type LinkChannel = Exclude<Channel, "none">;
export type WidgetType = "chart" | "orderflow" | "moneyflow" | "chain" | "dom" | "scanner" | "hlscanner" | "watchlist" | "media";
export type Screen = 0 | 1 | 2;
export type TF = "1m" | "3m" | "5m" | "15m";
export type Range = "1D" | "5D" | "15D";
export type Preset = "1" | "2v" | "4" | "5p" | "8";

export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloatRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WidgetConfig {
  id: string;
  type: WidgetType;
  symbol: string;
  channel: Channel;
  screen: Screen;
  float: FloatRect | null;
  settings: Record<string, unknown>;
}

export type DrawingKind = "trend" | "hline" | "vprofile";

export interface Drawing {
  id: string;
  kind: DrawingKind;
  t1: number;
  p1: number;
  t2?: number;
  p2?: number;
  color: string;
}

export interface ChannelState {
  symbol: string;
  mark: number | null;
}

export interface Workspace {
  widgets: Record<string, WidgetConfig>;
  layouts: Record<Screen, GridItem[]>;
  channels: Record<LinkChannel, ChannelState>;
  tf: TF;
  range: Range;
  preset: Preset;
  ticker: { symbols: string[]; speed: number; enabled: boolean };
  drawings: Record<string, Drawing[]>;
  scalper: ScalperConfig;
}

export const WIDGET_LABELS: Record<WidgetType, string> = {
  chart: "Chart",
  orderflow: "Order Flow Matrix",
  moneyflow: "Money Flow Profile",
  chain: "Option Chain",
  dom: "DOM / Depth",
  scanner: "Power Scanner",
  hlscanner: "High/Low Scanner",
  watchlist: "Watchlist",
  media: "Media / Stream",
};

export const GRID_COLS = 12;
export const GRID_ROWS = 12;
export const MAX_TILES = 8;

const DEFAULT_SYMBOLS = ["NIFTY-FUT", "BANKNIFTY-FUT", "NIFTY", "BANKNIFTY", "SENSEX-FUT", "RELIANCE", "HDFCBANK", "FINNIFTY-FUT"];

export const PRESET_LABELS: Record<Preset, string> = {
  "1": "1-Grid",
  "2v": "2-Vertical",
  "4": "4-Grid",
  "5p": "5-Pie",
  "8": "8-Grid Matrix",
};

export function presetCells(p: Preset): Omit<GridItem, "i">[] {
  switch (p) {
    case "1":
      return [{ x: 0, y: 0, w: 12, h: 12 }];
    case "2v":
      return [
        { x: 0, y: 0, w: 6, h: 12 },
        { x: 6, y: 0, w: 6, h: 12 },
      ];
    case "4":
      return [
        { x: 0, y: 0, w: 6, h: 6 },
        { x: 6, y: 0, w: 6, h: 6 },
        { x: 0, y: 6, w: 6, h: 6 },
        { x: 6, y: 6, w: 6, h: 6 },
      ];
    case "5p":
      return [
        { x: 0, y: 0, w: 6, h: 12 },
        { x: 6, y: 0, w: 3, h: 6 },
        { x: 9, y: 0, w: 3, h: 6 },
        { x: 6, y: 6, w: 3, h: 6 },
        { x: 9, y: 6, w: 3, h: 6 },
      ];
    case "8":
      return Array.from({ length: 8 }, (_, k) => ({ x: (k % 4) * 3, y: Math.floor(k / 4) * 6, w: 3, h: 6 }));
  }
}

let idSeq = 0;
export function newId(prefix = "w"): string {
  idSeq++;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function defaultSettings(type: WidgetType): Record<string, unknown> {
  switch (type) {
    case "chart":
      return {
        chartType: "candles",
        tf: "global",
        volume: true,
        deltaPane: false,
        cvd: false,
        bell: false,
        intensity: false,
        stats: false,
        vwap: true,
        divergence: true,
        divThreshold: 100,
        mfArrows: false,
        mfThreshold: 500,
        scalper: false,
        fpTicks: "auto",
        fpRatio: 3,
        fpMode: "diagonal",
        fpDisplay: "bidask",
        units: "lots",
        tpoPeriod: 30,
        tpoMode: "letters",
        tpoRow: "auto",
        tpoMerges: [],
        tpoSplits: [],
      };
    case "orderflow":
      return { tf: "5m", units: "lots" };
    case "moneyflow":
      return { mode: "standard", live: true, rangeMin: 30, units: "value" };
    case "chain":
      return { expiry: "", strikes: 12 };
    case "dom":
      return { level: "L3", group: 1, autoCenter: true, heatmap: true };
    case "scanner":
      return {
        combinator: "AND",
        rules: [
          { metric: "volLots", op: ">", value: 1000 },
          { metric: "deltaLots", op: ">", value: 300 },
        ],
      };
    case "hlscanner":
      return { filter: "both" };
    case "watchlist":
      return {
        group: "Indices",
        groups: {
          Indices: ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "INDIAVIX"],
          Futures: ["NIFTY-FUT", "BANKNIFTY-FUT", "FINNIFTY-FUT", "SENSEX-FUT"],
          Banking: ["HDFCBANK", "ICICIBANK", "SBIN", "AXISBANK", "KOTAKBANK"],
          "IT & Others": ["INFY", "TCS", "HCLTECH", "RELIANCE", "LT", "ITC", "BHARTIARTL", "MARUTI", "M&M", "SUNPHARMA", "HINDUNILVR"],
        },
      };
    case "media":
      return { url: "", aspect: "16:9", volume: 50, muted: true, audioOnly: false };
  }
}

function makeWidget(type: WidgetType, symbol: string, channel: Channel, screen: Screen = 0, settings: Record<string, unknown> = {}): WidgetConfig {
  return { id: newId(), type, symbol, channel, screen, float: null, settings: { ...defaultSettings(type), ...settings } };
}

function defaultWorkspace(): Workspace {
  const a = makeWidget("chart", "NIFTY-FUT", "red", 0, { chartType: "footprint", tf: "5m", deltaPane: true, stats: true, mfArrows: true });
  const b = makeWidget("chart", "NIFTY-FUT", "red", 0, { chartType: "tpo", volume: false });
  const c = makeWidget("chain", "NIFTY-FUT", "red");
  const d = makeWidget("moneyflow", "NIFTY-FUT", "red");
  const e = makeWidget("chart", "NIFTY", "none", 0, { tf: "5m", scalper: true, mfArrows: true, volume: false });
  const cells = presetCells("5p");
  const ids = [a, e, b, c, d].map((w) => w.id);
  return {
    widgets: Object.fromEntries([a, b, c, d, e].map((w) => [w.id, w])),
    layouts: { 0: ids.map((i, k) => ({ i, ...cells[k] })), 1: [], 2: [] },
    channels: {
      red: { symbol: "NIFTY-FUT", mark: null },
      blue: { symbol: "BANKNIFTY-FUT", mark: null },
      yellow: { symbol: "RELIANCE", mark: null },
    },
    tf: "5m",
    range: "5D",
    preset: "5p",
    ticker: { symbols: ["NIFTY", "BANKNIFTY", "FINNIFTY", "SENSEX", "INDIAVIX", "NIFTY-FUT", "BANKNIFTY-FUT", "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN"], speed: 60, enabled: true },
    drawings: {},
    scalper: defaultScalper("NIFTY"),
  };
}

interface WorkspaceStore {
  ws: Workspace;
  current: string;
  saved: Record<string, Workspace>;
  // widgets
  addWidget: (type: WidgetType, screen?: Screen) => string | null;
  removeWidget: (id: string) => void;
  updateSettings: (id: string, patch: Record<string, unknown>) => void;
  setWidgetType: (id: string, type: WidgetType) => void;
  setSymbol: (id: string, symbol: string) => void;
  setChannel: (id: string, channel: Channel) => void;
  setMark: (channel: Channel, t: number | null) => void;
  setChannelSymbol: (channel: LinkChannel, symbol: string) => void;
  popout: (id: string, screen: Screen) => void;
  setFloat: (id: string, rect: FloatRect | null) => void;
  // layout
  setLayout: (screen: Screen, layout: GridItem[]) => void;
  applyPreset: (preset: Preset, screen?: Screen) => void;
  setTf: (tf: TF) => void;
  setRange: (r: Range) => void;
  setTicker: (p: Partial<Workspace["ticker"]>) => void;
  setScalper: (p: Partial<ScalperConfig>) => void;
  // drawings
  addDrawing: (symbol: string, d: Drawing) => void;
  updateDrawing: (symbol: string, id: string, p: Partial<Drawing>) => void;
  removeDrawing: (symbol: string, id: string) => void;
  clearDrawings: (symbol: string) => void;
  // workspaces
  saveAs: (name: string) => void;
  overwrite: () => void;
  load: (name: string) => void;
  deleteSaved: (name: string) => void;
  exportJson: () => string;
  importJson: (json: string) => string | null;
  reset: () => void;
  replaceWs: (ws: Workspace) => void;
}

function tilesOn(ws: Workspace, screen: Screen): number {
  return Object.values(ws.widgets).filter((w) => w.screen === screen && !w.float).length;
}

function placeAtBottom(layout: GridItem[], id: string, w = 6, h = 6): GridItem[] {
  if (!layout.length) return [{ i: id, x: 0, y: 0, w: GRID_COLS, h: GRID_ROWS }];
  const bottom = layout.reduce((m, it) => Math.max(m, it.y + it.h), 0);
  return [...layout, { i: id, x: 0, y: bottom, w, h }];
}

export const useWorkspace = create<WorkspaceStore>()(
  persist(
    (set, get) => {
      const patchWs = (fn: (ws: Workspace) => Partial<Workspace>) => set((s) => ({ ws: { ...s.ws, ...fn(s.ws) } }));
      const patchWidget = (id: string, fn: (w: WidgetConfig) => Partial<WidgetConfig>) =>
        patchWs((ws) => (ws.widgets[id] ? { widgets: { ...ws.widgets, [id]: { ...ws.widgets[id], ...fn(ws.widgets[id]) } } } : {}));
      return {
        ws: defaultWorkspace(),
        current: "Default",
        saved: {},

        addWidget: (type, screen = 0) => {
          const ws = get().ws;
          if (tilesOn(ws, screen) >= MAX_TILES) return null;
          const sym = ws.channels.red.symbol;
          const w = makeWidget(type, sym, "red", screen);
          patchWs((ws) => ({
            widgets: { ...ws.widgets, [w.id]: w },
            layouts: { ...ws.layouts, [screen]: placeAtBottom(ws.layouts[screen], w.id, type === "media" ? 4 : 6, 6) },
          }));
          return w.id;
        },
        removeWidget: (id) =>
          patchWs((ws) => {
            const widgets = { ...ws.widgets };
            delete widgets[id];
            const layouts = { 0: ws.layouts[0].filter((l) => l.i !== id), 1: ws.layouts[1].filter((l) => l.i !== id), 2: ws.layouts[2].filter((l) => l.i !== id) };
            return { widgets, layouts };
          }),
        updateSettings: (id, patch) => patchWidget(id, (w) => ({ settings: { ...w.settings, ...patch } })),
        setWidgetType: (id, type) => patchWidget(id, () => ({ type, settings: defaultSettings(type) })),
        setSymbol: (id, symbol) => {
          const w = get().ws.widgets[id];
          if (!w) return;
          if (w.channel !== "none") get().setChannelSymbol(w.channel, symbol);
          else patchWidget(id, () => ({ symbol }));
        },
        setChannel: (id, channel) => {
          const w = get().ws.widgets[id];
          if (!w) return;
          // leaving a channel keeps the channel's symbol on the widget
          const symbol = w.channel !== "none" ? get().ws.channels[w.channel].symbol : w.symbol;
          patchWidget(id, () => ({ channel, symbol }));
        },
        setMark: (channel, t) => {
          if (channel === "none") return;
          patchWs((ws) => ({ channels: { ...ws.channels, [channel]: { ...ws.channels[channel], mark: t } } }));
        },
        setChannelSymbol: (channel, symbol) =>
          patchWs((ws) => ({ channels: { ...ws.channels, [channel]: { ...ws.channels[channel], symbol, mark: null } } })),
        popout: (id, screen) =>
          patchWs((ws) => {
            const w = ws.widgets[id];
            if (!w || w.screen === screen) return {};
            const layouts = { ...ws.layouts, [w.screen]: ws.layouts[w.screen].filter((l) => l.i !== id) } as Record<Screen, GridItem[]>;
            layouts[screen] = placeAtBottom(layouts[screen], id);
            return { widgets: { ...ws.widgets, [id]: { ...w, screen, float: null } }, layouts };
          }),
        setFloat: (id, rect) =>
          patchWs((ws) => {
            const w = ws.widgets[id];
            if (!w) return {};
            let layouts = ws.layouts;
            if (rect && !w.float) layouts = { ...layouts, [w.screen]: layouts[w.screen].filter((l) => l.i !== id) };
            if (!rect && w.float) layouts = { ...layouts, [w.screen]: placeAtBottom(layouts[w.screen], id) };
            return { widgets: { ...ws.widgets, [id]: { ...w, float: rect } }, layouts };
          }),

        setLayout: (screen, layout) =>
          patchWs((ws) => ({ layouts: { ...ws.layouts, [screen]: layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })) } })),
        applyPreset: (preset, screen = 0) =>
          patchWs((ws) => {
            const cells = presetCells(preset);
            const onScreen = ws.layouts[screen]
              .slice()
              .sort((a, b) => a.y - b.y || a.x - b.x)
              .map((l) => l.i)
              .filter((i) => ws.widgets[i] && !ws.widgets[i].float);
            const widgets = { ...ws.widgets };
            const keep = onScreen.slice(0, cells.length);
            for (const drop of onScreen.slice(cells.length)) delete widgets[drop];
            let k = 0;
            while (keep.length < cells.length) {
              const sym = DEFAULT_SYMBOLS[(keep.length + k++) % DEFAULT_SYMBOLS.length];
              const w = makeWidget("chart", sym, "none", screen);
              widgets[w.id] = w;
              keep.push(w.id);
            }
            return { widgets, preset, layouts: { ...ws.layouts, [screen]: keep.map((i, n) => ({ i, ...cells[n] })) } };
          }),
        setTf: (tf) => patchWs(() => ({ tf })),
        setRange: (range) => patchWs(() => ({ range })),
        setTicker: (p) => patchWs((ws) => ({ ticker: { ...ws.ticker, ...p } })),
        setScalper: (p) => patchWs((ws) => ({ scalper: { ...ws.scalper, ...p } })),

        addDrawing: (symbol, d) => patchWs((ws) => ({ drawings: { ...ws.drawings, [symbol]: [...(ws.drawings[symbol] ?? []), d] } })),
        updateDrawing: (symbol, id, p) =>
          patchWs((ws) => ({ drawings: { ...ws.drawings, [symbol]: (ws.drawings[symbol] ?? []).map((d) => (d.id === id ? { ...d, ...p } : d)) } })),
        removeDrawing: (symbol, id) =>
          patchWs((ws) => ({ drawings: { ...ws.drawings, [symbol]: (ws.drawings[symbol] ?? []).filter((d) => d.id !== id) } })),
        clearDrawings: (symbol) => patchWs((ws) => ({ drawings: { ...ws.drawings, [symbol]: [] } })),

        saveAs: (name) => {
          const n = name.trim();
          if (!n) return;
          set((s) => ({ saved: { ...s.saved, [n]: structuredClone(s.ws) }, current: n }));
        },
        overwrite: () => set((s) => ({ saved: { ...s.saved, [s.current]: structuredClone(s.ws) } })),
        load: (name) => {
          const w = get().saved[name];
          if (w) set({ ws: structuredClone(w), current: name });
        },
        deleteSaved: (name) =>
          set((s) => {
            const saved = { ...s.saved };
            delete saved[name];
            return { saved, current: s.current === name ? "Default" : s.current };
          }),
        exportJson: () => JSON.stringify({ format: "odx-terminal-workspace", version: 1, name: get().current, workspace: get().ws }, null, 2),
        importJson: (json) => {
          try {
            const data = JSON.parse(json);
            const ws = (data.workspace ?? data) as Workspace;
            if (!ws.widgets || !ws.layouts || !ws.channels) return "Not a workspace file";
            const name = String(data.name ?? "Imported");
            set((s) => ({ ws: { ...defaultWorkspace(), ...ws }, saved: { ...s.saved, [name]: ws }, current: name }));
            return null;
          } catch (e) {
            return `Invalid JSON: ${(e as Error).message}`;
          }
        },
        reset: () => set({ ws: defaultWorkspace(), current: "Default" }),
        replaceWs: (ws) => set({ ws }),
      };
    },
    {
      name: "odx.workspace.v1",
      version: 1,
      partialize: (s) => ({ ws: s.ws, current: s.current, saved: s.saved }),
      merge: (persisted, current) => {
        const p = persisted as Partial<WorkspaceStore> | undefined;
        if (!p?.ws) return current;
        return { ...current, ...p, ws: { ...defaultWorkspace(), ...p.ws, scalper: { ...defaultScalper(), ...(p.ws.scalper ?? {}) } } };
      },
    },
  ),
);

/** The symbol a widget currently shows (its channel's symbol when linked). */
export function effectiveSymbol(ws: Workspace, w: WidgetConfig): string {
  return w.channel !== "none" ? ws.channels[w.channel].symbol : w.symbol;
}

export function useWidget(id: string): WidgetConfig | undefined {
  return useWorkspace((s) => s.ws.widgets[id]);
}

export function useWidgetSymbol(id: string): string {
  return useWorkspace((s) => {
    const w = s.ws.widgets[id];
    return w ? effectiveSymbol(s.ws, w) : "NIFTY-FUT";
  });
}
