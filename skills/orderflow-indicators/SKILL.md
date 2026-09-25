---
name: orderflow-indicators
description: >
  Use when building or explaining orderflow and auction-market indicators for
  Indian futures/options from Dhan or Zerodha live feeds: footprint / cluster
  charts (bid x ask, delta, diagonal and stacked imbalances, absorption),
  volume profile (POC, VAH, VAL, HVN, LVN, composite / developing profiles),
  TPO / market profile (letters, initial balance, single prints, poor highs
  and lows, open types, day types), cumulative volume delta and divergence,
  VWAP with SD bands, big-trade bubbles, and DOM / depth heatmaps. Covers
  reconstructing trades from snapshot ticks (NSE retail APIs are not
  tick-by-tick). Quantower-style and ODXCharts-style indicators.
compatibility: >
  scripts/orderflow_engine.py is pure Python 3.8+ standard library. Feed it
  normalized ticks from the dhanhq or zerodha-kite skills.
---

# Orderflow Indicators (Footprint · Volume Profile · TPO · CVD)

Reference implementation: `scripts/orderflow_engine.py` (tested; run it for a
demo). Reuse it in the backend and port the rendering side to the frontend.

## 1. Normalize ticks

Every broker packet becomes one `Tick(ts, symbol, ltp, cum_volume, bid, ask, bid_qty, ask_qty, oi)`.

| Tick field | Dhan MarketFeed (Full) | Kite KiteTicker (full) |
|------------|------------------------|------------------------|
| `ts` | `LTT` | `exchange_timestamp` / `last_trade_time` |
| `ltp` | `float(LTP)` | `last_price` |
| `cum_volume` | `volume` | `volume_traded` |
| `bid`, `bid_qty` | `depth[0].bid_price`, `bid_quantity` | `depth.buy[0].price`, `quantity` |
| `ask`, `ask_qty` | `depth[0].ask_price`, `ask_quantity` | `depth.sell[0].price`, `quantity` |
| `oi` | `OI` | `oi` |

Dhan numeric fields arrive as strings in the SDK — cast them. Subscribe in
`Full` mode (Dhan) / `MODE_FULL` (Kite); Ticker/LTP mode has no volume or quotes.

## 2. Reconstruct trades from snapshots

NSE retail feeds are snapshots: between two packets many trades may have
happened. Treat each packet's volume increase as one aggregated print:

```
dv = cum_volume - prev.cum_volume          # skip if <= 0 (no trade / reset)
side = BUY  if ltp >= prev.ask             # lifted the offer
       SELL if ltp <= prev.bid             # hit the bid
       else tick rule: up-tick BUY, down-tick SELL, unchanged = previous side
```

Use the **previous** snapshot's bid/ask (the quote the aggressor traded
against). This is `TradeClassifier` in the script. Caveats to surface in docs
and UI:

- It is an estimate. Accuracy improves with faster feeds (Dhan 20-level depth
  packets, subscribe fewer instruments per connection).
- `last_traded_quantity` is only the final trade in the interval; use `dv`.
- Reset the classifier state after reconnects and at session start.
- Index spot (NIFTY 50) has no volume → use NIFTY-I futures or option contracts.

## 3. Footprint

Per bar (time, tick-count, or volume bars) keep `price_row -> [bid_vol, ask_vol]`.

- Row size: NIFTY fut 1–5 pts, BANKNIFTY fut 5–20 pts, options 0.5–2 pts.
  Tick size 0.05 is too fine for readability; always aggregate rows.
- **Delta** = Σ ask − Σ bid. **Bar POC** = row with max total volume.
- **Diagonal imbalance** (Quantower/most platforms): buy imbalance at `p` if
  `ask[p] >= ratio * bid[p - row]`; sell imbalance at `p` if
  `bid[p] >= ratio * ask[p + row]`. Typical ratio 3.0 (300%), with a minimum
  volume filter.
- **Stacked imbalance**: ≥3 consecutive imbalance rows → support (buy) /
  resistance (sell) zone that often gets retested.
- **Absorption**: large volume on one side at the bar extreme with little
  price progress (e.g. heavy bid volume at the low, delta negative, but close
  in upper half).
- **Exhaustion / unfinished auction**: very low volume at the bar high/low
  (finished) vs non-zero bid AND ask at the extreme (unfinished, likely revisit).
- Display modes: bid×ask, delta, volume, delta% ; color by imbalance and by
  volume intensity.

## 4. Volume profile

Histogram of volume by price row over a range (session, composite N days,
visible range, or per bar).

- **POC**: max volume row (tie → closest to range midpoint).
- **Value area (70%)**: start at POC, repeatedly add the heavier adjacent row
  (above vs below) until 70% of volume is covered → VAL / VAH. The CBOT variant
  compares two rows at a time; either is acceptable, be consistent.
- **HVN / LVN**: local maxima / minima; LVNs act as fast-move zones, HVNs as
  magnets / balance.
- **Developing POC/VA**: recompute on every bar and store the series so the
  chart can draw it and ML can use it without look-ahead.
- Delta profile: per-row Σ(qty × side).

## 5. TPO / Market profile

NSE session 09:15–15:30 → 30-min periods: A 09:15, B 09:45, C 10:15, … M 15:15
(15 min). Each period stamps its letter on every row it traded through.

- **Initial Balance (IB)** = A + B range (09:15–10:15).
- **TPO POC / VA**: same value-area algorithm on letter counts.
- **Single prints**: rows with exactly one TPO inside the range → fast
  auction, later acts as support/resistance.
- **Poor high/low**: ≥2 TPOs at the extreme → unfinished auction, likely revisit.
- **Range extension**: price beyond IB high/low after B period.
- Open types: Open-Drive, Open-Test-Drive, Open-Rejection-Reverse,
  Open-Auction (in / out of previous range).
- Day types: Normal, Normal Variation, Trend, Double Distribution, Neutral,
  Non-Trend — classify from IB width vs average IB and extension behaviour.
- Previous-day VAH/VAL/POC, naked (untested) POCs, and IB high/low are the
  key levels most option-buying setups trade against.

## 6. CVD, VWAP, big trades

- **CVD**: running Σ delta (reset daily or anchored). Divergence: price makes
  a higher high while CVD makes a lower high (and vice versa).
- **VWAP**: Σpv/Σv with volume-weighted SD bands (±1, ±2). Anchored VWAP from
  swing points / IB break.
- **Big trades**: prints with `dv >= N × lot_size`; plot as bubbles sized by
  qty, colored by side. They are aggregated snapshot volume, not single orders.

## 7. DOM ladder and depth heatmap

- Dhan `FullDepth` gives 20 levels (up to 50 instruments) or 200 levels
  (1 instrument per connection) for NSE_EQ / NSE_FNO. Kite gives 5 levels.
- Heatmap: sample the book every 250–500 ms into `time × price → resting qty`,
  render as an intensity image behind candles. Keep a rolling window in a
  ring buffer.
- Pulling/stacking: change in resting qty at a level between samples that is
  not explained by traded volume at that price.

## 8. Engineering rules

- One aggregation code path for live and replay; backtests replay stored ticks.
- Aggregate on the backend, push only changed cells of the current bar to the
  browser, and a full snapshot on subscribe.
- Store raw ticks (not just bars) so row size / bar type can change later.
- Timestamps in IST; align bars to 09:15, not to clock hours.
