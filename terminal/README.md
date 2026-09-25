# OrderFlow Terminal

A browser-based, high-density trading terminal for Indian F&O, equity and
futures traders, inspired by desktop order-flow platforms (Quantower-style
indicators) and web terminals such as ODX Charts. Built with **Next.js 16 +
React 19 + Tailwind CSS 4**, custom **canvas** chart engines, and a built-in
**mock market feed** so everything works offline on `localhost:3000`.

> This is an independent implementation of public order-flow concepts
> (footprint, TPO, volume profile, DOM, options flow). It does not copy any
> other product's code, branding or proprietary indicators. The bundled data is
> **simulated**. It is not investment advice.


---

## Quick start

```bash
cd terminal
npm install
npm run dev          # http://localhost:3000  (UI + mock WebSocket feed at ws://localhost:3000/feed)
```

- `http://localhost:3000/?speed=10` runs the simulated market 10× faster (the
  first window to connect sets the speed).
- Without the Node server (e.g. `npm run dev:next`, static hosting, or when
  `/feed` is unreachable) the terminal falls back to **Trial Mode**: the same
  simulator runs in a browser `SharedWorker`, shared by the main window and all
  pop-out screens.
- `npm test` runs the unit tests (analytics + simulator), `npm run typecheck`
  checks both the app and server TypeScript projects.

Production:

```bash
npm run build && npm start               # PORT=3000 HOST=0.0.0.0 SIM_SPEED=1
docker compose up -d --build             # same thing in a container
```

---

## What's inside (by phase)

### Phase 1 — Shell, layout engine, workspaces
| Feature | Where |
|---|---|
| Broker connection engine: **Connected** (WebSocket backend) / **Trial Mode** (in-browser sim) / **Disconnected**, with latency, broker picker (Mock / Dhan / Zerodha) and backend URL | `components/shell/TopBar.tsx`, `lib/feed/client.ts` |
| Scrolling ticker tape, customizable symbols and speed, click to link | `components/shell/TickerTape.tsx` |
| Workspace manager: Save as, Load, Overwrite, Delete, Export JSON, Import JSON, Reset | `TopBar.tsx` → `lib/state/workspace.ts` |
| Layout presets: 1-Grid, 2-Vertical, 4-Grid, 5-Pie, 8-Grid Matrix | `presetCells()` |
| Global timeframe (1m / 3m / 5m / 15m) and history range (1D / 5D / 15D) | `TimeControls` |
| Zero-gap drag-and-drop and resizable grid, up to 8 tiles per screen | `components/grid/WidgetGrid.tsx` (react-grid-layout v2) |
| Widget header: symbol search, chart type (Candles / Footprint / TPO), link channel (Red / Blue / Yellow / None), float, pop-out, close | `components/grid/WidgetFrame.tsx` |
| Symbol linking: every widget on a colour channel follows that channel's symbol | `setSymbol()` / `effectiveSymbol()` |
| Pop-out to **Screen 1 / Screen 2** browser windows; workspace, channels, marks and crosshairs synced with **BroadcastChannel** | `lib/state/sync.ts`, `app/popout` |
| Floating (PiP) widgets over the grid | `components/grid/FloatingLayer.tsx` |

### Phase 2 — Charting engines
- **Candlestick engine** (`components/chart/PriceChartEngine.ts`): canvas, wheel zoom
  around the cursor, drag pan, auto-scaling price axis (drag or wheel on the
  axis for manual scale, double-click to reset), crosshair, day separators.
- **Drawing tools:** trendline, horizontal support/resistance, **fixed-range volume
  profile** (POC / VAH / VAL). Drawings are stored per symbol and can be moved
  (drag) and deleted (select + Del).
- **Footprint:** bid × ask clusters inside each bar, bar POC, delta / volume
  display modes, auto row size or fixed **10 / 20 / 40 / 50 / 100 / 200-tick**
  rows, **imbalance** highlighting with a configurable ratio (default 300 %),
  diagonal or same-row comparison, stacked-imbalance markers.
- **TPO / Market Profile** (`components/chart/TpoChartEngine.ts`): letters or blocks,
  15 / 30 / 60-minute periods, POC, VAH / VAL, value-area shading, single
  prints, initial balance, open / close markers, **split** a profile at any
  period and **merge** adjacent profiles (shift-click to multi-select).

### Phase 3 — Order flow matrix & delta indicators
- **Order Flow Matrix** widget: top histogram of volume and delta per bar; for 5m+
  bars each candle is split into **1-minute intervals** (Row 1 = delta %, Row 2 =
  volume in lots) with heat shading at >25 % / >50 % / >75 %.
- **Delta divergence** flags (price up with delta ≤ −threshold, or down with
  delta ≥ +threshold; default ±100 lots).
- **Total Bell** aggregated volume (Gaussian-smoothed, causal) and **Market
  Activity Intensity** (prints + volume per minute vs. trailing 30 bars, 0–100).
- **Bar statistics table:** Delta, Min Δ, Max Δ, Cumulative Δ, Volume, toggle
  **Lots / Shares**.

### Phase 4 — Options analytics
- **Money Flow Profile:** per-strike aggressive call/put buying vs. selling in ₹ or
  lots; **Standard** (session), **Range** (last N minutes) and **Series**
  (bullish/bearish ₹ per bar + cumulative net) modes.
- **Institutional flow arrows** on charts: green ↑ = aggressive put selling
  (bullish), red ↓ = aggressive call selling (bearish); **3+ stacked on one
  candle = INST**. A strike counts when its net selling in a single minute
  exceeds the threshold, so the logic is identical on every timeframe.
- **Mark mode vs Live mode:** ⚑ Mark on a chart, click a candle → the Money Flow
  profile on the same channel pins to that time; ● Live streams.
- **Option chain:** LTP / change, IV, volume, OI and OI change for calls and puts,
  OI bars, ITM shading, ATM highlight, PCR, max pain, synthetic future; click a
  cell to link that option to the channel's charts.

### Phase 5 — DOM surface, L3/L4 depth, scanners
- **DOM ladder** with **L2** (5 levels), **L3** (20 levels with order-by-order queue
  segments and order counts) and **L4** (200 levels); tick grouping, auto-centre.
- **DOM Surface heatmap** of resting liquidity over time with the last-price path,
  traded bubbles, and markers for **pulled** walls (✕), **stacking** (+) and
  **iceberg refills** (◆).
- **Paper orders with queue-position tracking:** click the bid/ask column to place
  a paper limit; the queue ahead shrinks with trades and cancellations until
  filled; right-click cancels.
- **Power Scanner** with a rule builder (AND/OR; volume, delta, delta %, volume
  surge, change %, stacked imbalance, OI change, range position) and presets,
  e.g. *Volume > 1000 lots AND Delta > +300*.
- **Intraday High/Low scanner** (streaming fresh day highs / lows) and grouped
  **watchlists** with hover chart previews.

### Phase 6 — Synthetic futures & options scalper
- `Synthetic Future = Strike + ATM Call − ATM Put`, drawn as a midline.
- **BEP levels:** previous-close straddle and anchor-time straddle
  (09:15 / 09:20 / custom): `K ± (CE + PE)`; **R1/R2, S1/S2** at ± base offset.
- **OG_Scalper HUD** (draggable): ATM CE / PE previous close, LTP, BEP, change, SL,
  **Total Added Premium**, straddle now vs anchor, synthetic future.
- **Multi-option candles:** ATM CE, ATM PE, CE ITM, PE ITM as a sub-pane or overlay.
- **Inputs panel:** stock/index, expiry (YYMMDD), base strike, base offset points,
  SL points, straddle anchor, days to show.
- Levels are computed on the index; on a futures chart they are shifted by the
  live basis.

### Phase 7 — Media, local dev, deployment
- **Media / Stream widget:** YouTube URL / ID / live link or audio stream, play,
  pause, mute, volume, aspect ratio, audio-only, **PiP** float.
- **Local dev:** `npm run dev` runs the custom Node server (Next.js + mock feed) with
  hot reload on `localhost:3000`.
- **Docker** multi-stage image (non-root, health check), **docker-compose**,
  **Nginx** reverse proxy with **wss://** upgrade, **Let's Encrypt** (certbot),
  **PM2** config, and a one-shot **DigitalOcean Droplet** script.

---

## Architecture

```
Browser windows (main + Screen 1 + Screen 2)
 ├─ React shell / grid (zustand workspace, persisted, BroadcastChannel sync)
 ├─ Canvas engines: PriceChartEngine (candles/footprint), TpoChartEngine, DOM, matrix
 ├─ MarketStore — applies feed messages, notifies once per animation frame (60 FPS)
 └─ FeedClient — WebSocket to /feed (or your backend) ─┐   fallback: SharedWorker simulator
                                                       │
Node server (server/index.ts)                          │
 ├─ Next.js request handler                            │
 └─ ws /feed ── SimHost ── MarketSim + DepthBook ◄─────┘
```

- Data is aggregated from 1-minute bars (footprint cells included) to any
  timeframe on the client (`lib/data/aggregate.ts`), incrementally.
- Charts subscribe to the store directly and re-render on `requestAnimationFrame`
  only when something changed; tables re-render at ≤ 1–2 Hz.
- Snapshot-based order flow: NSE retail APIs are not tick-by-tick, so
  aggressor side is estimated (quote rule, tick-rule fallback). See the
  `orderflow-indicators` skill in this repo.

## Connecting a real broker (Dhan / Zerodha)

Broker credentials must stay on a server. Run a backend (see the
`trading-terminal-backend`, `dhanhq` and `zerodha-kite` skills) that speaks the
protocol in `src/lib/feed/protocol.ts`, then open **Broker connection** in the
toolbar, choose the broker and enter its `wss://…/feed` URL.

| Client → server | Meaning |
|---|---|
| `{op:"hello", speed?}` | handshake |
| `{op:"sub", key, sub}` | `sub` = `{kind:"bars", symbol, days}` · `{kind:"depth", symbol, levels}` · `{kind:"chain", root, expiry}` · `{kind:"mflow", root, days}` |
| `{op:"unsub", key}` · `{op:"ping", ts}` | |

| Server → client | Payload |
|---|---|
| `hello` | `source`, `instruments[]`, `simTime`, `speed` |
| `hist` / `bars` | 1-minute `Bar` `{t,o,h,l,c,v,d,dmin,dmax,n,oi?,cells:[price,bid,ask,…]}` |
| `quotes` | per-symbol LTP, OHLC, prev close, volume, OI, last-bar volume/delta, imbalance score |
| `depth` | `{bids,asks:[[price,qty,orders,...orderSizes]], traded, events}` |
| `chain` | strikes with CE/PE `ltp, chg, iv, vol, oi, oiChg, bid, ask, delta` |
| `mflow_hist` / `mflow` | per-minute `[strike, ceBuy, ceSell, peBuy, peSell, ceP, peP]` (lots) |
| `clock` · `pong` · `error` | |

Volumes are in shares/contracts; the UI converts to lots with each instrument's
`lotSize`. The mock instrument master (`src/lib/sim/instruments.ts`) has
illustrative lot sizes; a real backend should send the broker's instrument list.

## Deploying to a DigitalOcean Droplet

1. Create an Ubuntu 22.04/24.04 droplet (2 GB RAM is enough), point a DNS A record
   at it.
2. `sudo DOMAIN=terminal.example.com EMAIL=you@example.com bash terminal/deploy/setup-droplet.sh`
   — installs Docker, Nginx, certbot and ufw, builds and starts the container,
   configures the reverse proxy (HTTP + `wss://…/feed` upgrade, 1 h read
   timeout, buffering off) and issues a Let's Encrypt certificate.
3. Updates: `git pull && cd terminal && docker compose up -d --build`.

Without Docker: `npm ci && npm run build`, then
`pm2 start deploy/ecosystem.config.cjs && pm2 save && pm2 startup`, and use
`deploy/nginx.conf` + `certbot --nginx`. Keep **one** instance: the mock market
lives in process memory, so PM2 cluster mode would give each worker a
different market. A restart takes ~2 s and browsers reconnect automatically.

For live Dhan / Zerodha order APIs you also need a static IP registered with
the broker (a Droplet reserved IP works) under SEBI's retail algo rules.

## Keyboard & mouse

| Action | How |
|---|---|
| Zoom time / price | wheel on chart / on price axis |
| Pan | drag; shift-drag also pans price |
| Reset view | double-click chart (price axis: auto-scale) |
| Delete drawing | click it, then Del / Backspace |
| Cancel tool | Esc |
| TPO multi-select | shift-click profiles |
| DOM paper order | click bid/ask column, right-click to cancel |

## Project layout

```
server/index.ts              custom Next.js server + ws /feed
src/app/                     page (main screen) and /popout (Screen 1/2)
src/components/shell/        top bar, ticker tape
src/components/grid/         grid, widget frame, symbol search, floating layer
src/components/chart/        canvas engines (price/footprint, TPO) + theme
src/components/widgets/      chart, order-flow matrix, money flow, option chain, DOM, scanners, watchlist, media, scalper
src/lib/sim/                 market simulator, L3 depth book, host, instruments, Black-Scholes
src/lib/feed/                protocol, WebSocket/SharedWorker client, store, hooks
src/lib/analytics/           footprint, profile, TPO, delta, money flow, scalper
src/lib/state/               workspace store, multi-window sync
deploy/                      nginx, PM2, droplet setup
tests/                       node:test unit tests
```
