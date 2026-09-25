---
name: browser-terminal-frontend
description: >
  Use when building the browser UI of a trading terminal (ODXCharts-style web
  terminal): React + TypeScript + Vite app with TradingView lightweight-charts
  for candles, custom Canvas/WebGL renderers for footprint (cluster) charts,
  TPO / market profile, volume profile side panels, depth heatmap, and DOM
  ladder; option chain grid with OI bars and Greeks; straddle chart; order
  ticket with one-click CE/PE buying; dockable multi-chart layouts; WebSocket
  client with requestAnimationFrame batching; dark theme; and performance
  techniques for high-frequency updates.
compatibility: >
  Node 18+, React 18+, TypeScript, Vite, lightweight-charts v5, zustand,
  dockview (or flexlayout-react), @msgpack/msgpack. Talks only to the
  trading-terminal-backend WebSocket/REST API, never directly to brokers.
---

# Browser Terminal Frontend

## Stack

| Concern | Choice | Why |
|---------|--------|-----|
| App | React + TypeScript + Vite | fast dev, typed WS messages |
| Candles, lines, histograms | `lightweight-charts` v5 (Apache-2.0) | small, fast, panes, custom series & primitives |
| Footprint, TPO, heatmap, DOM | custom Canvas 2D (WebGL for heatmap if needed) | no library does Indian-style footprint well |
| Layout | `dockview` | drag/dock/tab panels, saveable layouts |
| State | `zustand` | per-stream stores, no re-render storms |
| Transport | WebSocket + msgpack | compact footprint/heatmap updates |
| Grid (chain, orders) | plain virtualized table or AG Grid Community | |

Keep the lightweight-charts attribution enabled (licence requirement).

## Project shape

```
frontend/src/
├── ws/client.ts          # single socket, sub/unsub by id, reconnect + resubscribe
├── store/                # zustand slices: marketData, footprint, chain, orders, layout
├── charts/
│   ├── CandleChart.tsx   # lightweight-charts + VWAP/CVD panes
│   ├── FootprintSeries.ts# custom series plugin OR standalone canvas
│   ├── ProfilePrimitive.ts# volume profile drawn on chart's right edge
│   ├── TPOChart.tsx      # canvas letters grid
│   └── Heatmap.tsx
├── panels/               # Watchlist, OptionChain, Straddle, DOM, OrderTicket, Positions, Journal
└── App.tsx               # dockview layout
```

## WebSocket client with frame batching

Never `setState` per message. Buffer and flush once per animation frame.

```ts
import { decode } from "@msgpack/msgpack";

type Handler = (msgs: any[]) => void;
const handlers = new Map<string, Handler>();
const pending = new Map<string, any[]>();
let ws: WebSocket, scheduled = false;
const subs = new Map<string, object>();

export function connect(url: string) {
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => subs.forEach((s) => ws.send(JSON.stringify(s)));   // resubscribe
  ws.onmessage = (e) => {
    const m: any = typeof e.data === "string" ? JSON.parse(e.data) : decode(new Uint8Array(e.data));
    const key = m.id ?? m.type;
    (pending.get(key) ?? pending.set(key, []).get(key)!).push(m);
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  ws.onclose = () => setTimeout(() => connect(url), 1000);
}
function flush() {
  scheduled = false;
  pending.forEach((msgs, key) => handlers.get(key)?.(msgs));
  pending.clear();
}
export function subscribe(id: string, params: object, h: Handler) {
  const msg = { op: "sub", id, ...params };
  subs.set(id, msg); handlers.set(id, h);
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  return () => { subs.delete(id); handlers.delete(id); ws?.send(JSON.stringify({ op: "unsub", id })); };
}
```

## Candle chart (lightweight-charts v5)

```ts
import { createChart, CandlestickSeries, HistogramSeries, LineSeries, ColorType } from "lightweight-charts";

const IST = 19800; // lightweight-charts shows UTC; shift epoch seconds by +5:30
const chart = createChart(el, {
  layout: { background: { type: ColorType.Solid, color: "#0e1117" }, textColor: "#c9d1d9" },
  grid: { vertLines: { color: "#1f2630" }, horzLines: { color: "#1f2630" } },
  timeScale: { timeVisible: true, secondsVisible: false },
  crosshair: { mode: 0 },
});
const candles = chart.addSeries(CandlestickSeries, { upColor: "#26a69a", downColor: "#ef5350", borderVisible: false });
const vwap = chart.addSeries(LineSeries, { color: "#f0b429", lineWidth: 1 });
const cvd = chart.addSeries(LineSeries, { color: "#58a6ff" }, 1);       // pane 1
const vol = chart.addSeries(HistogramSeries, { priceFormat: { type: "volume" } }, 2);
candles.setData(bars.map((b) => ({ time: (b.t + IST) as any, open: b.o, high: b.h, low: b.l, close: b.c })));
// live: candles.update(lastBar) — same time replaces, newer time appends
```

Key levels (prev VAH/VAL/POC, IB high/low, max-OI strikes) →
`candles.createPriceLine({ price, color, lineStyle: 2, title: "pVAH" })`.

## Footprint renderer

Two viable approaches:

1. **Custom series plugin** (`chart.addCustomSeries(new FootprintSeries())`)
   implementing `ICustomSeriesPaneView` (`renderer()`, `update()`,
   `priceValueBuilder()` → `[low, high, close]`, `isWhitespace()`,
   `defaultOptions()`). Its renderer's `draw(target, priceToCoordinate)` uses
   `target.useBitmapCoordinateSpace(({ context, horizontalPixelRatio, verticalPixelRatio }) => ...)`.
   Shares time/price scales, crosshair, and zoom with the candle chart.
2. **Standalone canvas** with its own scales — more freedom (wide bars,
   per-cell text) but you reimplement pan/zoom/crosshair.

Rendering rules:

- Per bar, per row: draw `bid × ask` text only when row height ≥ ~11 px and
  bar width ≥ ~60 px; otherwise fall back to colored cells / delta heat.
- Cell background intensity ∝ row volume / max row volume in view; text
  color green for buy imbalance, red for sell imbalance; box the bar POC.
- Bar footer: volume, delta, delta %, CVD.
- Stacked imbalance zones: translucent horizontal bands extended right until
  price trades through them.
- Draw on devicePixelRatio-scaled canvas; cache text metrics; clip to the
  visible range (`timeScale().getVisibleLogicalRange()`).

## Volume profile / TPO

- Session/visible-range profile as a series primitive
  (`candles.attachPrimitive(profilePrimitive)`) drawing horizontal bars at the
  right edge; highlight POC and shade the value area.
- TPO chart as its own canvas: x = day columns (or split periods), y = price
  rows, letters colored by period; mark IB with a vertical bar, single prints,
  poor highs/lows, POC line, VA brackets. Allow merge/split of profiles.

## Heatmap and DOM

- Heatmap: keep `Float32Array` ring buffer `[timeSlots × priceRows]`; draw
  with `putImageData` (or WebGL texture) behind the candles; log-scale color.
- DOM ladder: fixed price rows centred on LTP, columns bid qty | price | ask
  qty | traded at price (bid/ask) | my orders; click bid/ask column to stage
  a LIMIT order; show working orders and SL on their rows.

## Options desk

- Chain grid: strikes centred on ATM, CE left / PE right; columns OI, ΔOI
  (bar), volume, IV, delta, LTP, bid/ask. Highlight max OI / max ΔOI.
- OI profile panel: horizontal CE/PE OI bars per strike next to the price axis.
- Straddle chart: line of ATM CE+PE premium + VWAP of straddle; IV line.
- Order ticket: symbol auto-picked from signal or chain click; lots stepper
  (lot size from instrument), LIMIT price = ask + buffer, mandatory SL
  (premium or underlying level), target, product (Intraday/Carry),
  "Paper/Live" badge, confirmation dialog showing max loss in ₹.

## Performance checklist

- One WebSocket; per-panel subscriptions by id; unsubscribe on unmount.
- Throttle UI to rAF; heavy transforms in a Web Worker.
- Mutate typed arrays / refs for chart data; React state only for UI controls.
- Limit footprint history in memory (e.g. last 2–3 sessions at 1m), fetch more
  on scroll-back via REST.
- Test with a replay of a volatile expiry day at 5–10× speed.
