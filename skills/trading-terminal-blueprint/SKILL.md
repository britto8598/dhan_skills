---
name: trading-terminal-blueprint
description: >
  Entry point for building a browser-based orderflow trading terminal for
  Indian markets (an ODXCharts-style web terminal with Quantower-style
  indicators) on Dhan and/or Zerodha. Use when the user wants to plan,
  scaffold, or extend the whole system: footprint charts, volume profile,
  TPO / market profile, CVD, DOM / heatmap, option chain + OI + Greeks
  dashboards, straddle charts, one-click option buying, risk engine, or ML
  signal filters. Explains the architecture, build phases, and which of the
  sibling skills (dhanhq, zerodha-kite, orderflow-indicators,
  options-oi-greeks, trading-terminal-backend, browser-terminal-frontend,
  option-buying-ml) to load for each part.
---

# Browser Orderflow Terminal — Blueprint

Goal: a self-hosted web terminal for NIFTY / BANKNIFTY / SENSEX futures and
options, fed by the user's own Dhan and/or Zerodha API sessions, with the
feature set traders know from ODXCharts (web) and Quantower (desktop).

Build **your own** implementation. Do not copy another product's code,
branding, logos, UI assets, or proprietary indicator names; reimplement the
public concepts (footprint, TPO, volume profile, CVD, OI analytics).

## Which skill to load

| Task | Skill |
|------|-------|
| Dhan orders, option chain, MarketFeed, FullDepth | `dhanhq` |
| Zerodha login, KiteTicker, orders, instruments | `zerodha-kite` |
| Tick → trade inference, footprint, VP, TPO, CVD, VWAP, big trades | `orderflow-indicators` |
| Greeks, IV, OI build-up, PCR, max pain, GEX, straddle | `options-oi-greeks` |
| FastAPI relay, broker adapters, tick bus, storage, OMS, risk engine | `trading-terminal-backend` |
| React UI, charts, canvas footprint/TPO, DOM ladder, layouts | `browser-terminal-frontend` |
| Features, labels, walk-forward ML filter for option buying | `option-buying-ml` |
| Quantower C# strategies (desktop) | `quantower-nifty-options` (if installed) |

## Architecture

```
 Dhan MarketFeed / FullDepth ─┐                         ┌─> Browser (React + Canvas)
                              ├─> Broker adapters ─> Tick bus ─> Aggregators ─> WS gateway ─┤   charts, DOM, chain,
 Zerodha KiteTicker ──────────┘     (normalize)      (asyncio/     (footprint,   (FastAPI)  │   order ticket
                                                      Redis)        VP, TPO, OI)            │
                                         │                                                  │
                                         └─> Tick store (Parquet/DuckDB or QuestDB)         │
 Order ticket ──> OMS + Risk engine ──> Dhan / Kite order API  <── order updates ───────────┘
```

Rules that shape everything:

1. **Broker tokens never reach the browser.** The browser talks only to your
   backend; the backend holds Dhan/Kite credentials.
2. **NSE retail feeds are snapshots**, not tick-by-tick. Orderflow is
   reconstructed from cumulative-volume deltas + bid/ask (see
   `orderflow-indicators`). Label it "estimated" in the UI.
3. **Spot indices have no volume.** Build footprint/VP/CVD on the current
   month future (NIFTY-I) or on the option contracts themselves; draw spot
   levels by subtracting the basis.
4. **Lot size, tick size, expiry day come from the instrument master**, never
   hardcoded (they change — e.g. NIFTY weekly expiry and lot size were revised
   in 2025).
5. **Paper mode is the default.** Live orders need explicit enablement,
   confirmation, and the risk engine.

## Feature map (ODX / Quantower-style)

| Feature | Data needed | Module |
|---------|-------------|--------|
| Candles 1m–1D, multi-TF | historical + live ticks | backend aggregator, lightweight-charts |
| Footprint (bid×ask, delta, imbalance, stacked) | ticks with bid/ask | `orderflow_engine.FootprintBuilder` + canvas |
| Volume profile (session, composite, visible range) | trades | `VolumeProfile` |
| TPO / market profile, IB, single prints, poor H/L | 1-min candles | `TPOProfile` |
| CVD + divergence | trades | `CVD` |
| VWAP + SD bands, anchored VWAP | trades | `VWAP` |
| Big trades bubbles | trades, lot size | `big_trades` |
| DOM ladder, depth heatmap | Dhan 20/200-level depth or Kite 5-level | FullDepth / KiteTicker full |
| Option chain with OI, ΔOI, IV, Greeks | chain snapshots | `options-oi-greeks` |
| OI profile by strike, PCR, max pain, GEX | chain snapshots over time | `greeks.py` |
| Straddle / strangle premium chart | ATM CE+PE ticks | `straddle_series` |
| One-click buy CE/PE with SL/target bracket | OMS | backend OMS |
| Journal + ML signal filter | stored features + fills | `option-buying-ml` |

## Build phases

1. **Data plumbing** — broker login, instrument master sync, live feed →
   normalized `Tick`, write ticks to disk. Verify volume deltas look sane.
2. **Aggregation** — candles, footprint, VP, TPO, CVD on NIFTY-I; replay a
   stored day through the same code path (backtest = replay).
3. **Gateway + UI shell** — FastAPI WebSocket, React layout, candle chart,
   watchlist, symbol search.
4. **Orderflow visuals** — canvas footprint, VP side panel, TPO chart, CVD pane,
   DOM ladder, heatmap.
5. **Options desk** — live chain, OI/ΔOI bars, straddle chart, Greeks, PCR.
6. **Execution** — order ticket, OMS, risk engine, positions/P&L, kill switch;
   paper mode first, then live with static IP.
7. **Intelligence** — journal every signal with features, train/validate ML
   filter walk-forward, surface probability in the UI.

## Suggested repo layout

```
terminal/
├── backend/            # Python 3.11+, FastAPI, asyncio
│   ├── brokers/        # dhan_adapter.py, kite_adapter.py, base.py
│   ├── engine/         # orderflow_engine.py, greeks.py, aggregators
│   ├── oms/            # order manager, risk engine, paper broker
│   ├── store/          # tick writer, replay
│   └── api/            # REST + WebSocket gateway
├── frontend/           # React + TypeScript + Vite
│   └── src/{charts,panels,store,ws}
├── research/           # notebooks, ML training, walk-forward reports
└── docker-compose.yml  # backend, redis, questdb (optional)
```

## Compliance and safety

- SEBI's retail algo framework (Feb 2025 circular) is in force: API order
  flow needs a static IP registered with the broker, and strategies above the
  exchange order-per-second threshold must be registered via the broker.
  Check the broker's current rules before going live.
- Market data from Dhan/Kite is licensed for the account holder's own use.
  Do not redistribute it to other users of a hosted terminal without a data
  vendor licence.
- Never promise profitability. Show backtest results net of costs and slippage.
