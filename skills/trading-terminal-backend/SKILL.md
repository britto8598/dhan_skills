---
name: trading-terminal-backend
description: >
  Use when building the server side of a browser trading terminal for Indian
  markets: Python FastAPI / asyncio service that logs in to Dhan and Zerodha,
  normalizes their live feeds behind a common broker adapter, runs orderflow /
  OI aggregators, streams updates to browsers over WebSocket, stores ticks for
  replay and backtesting, and executes orders through an OMS with a risk
  engine, paper-trading broker, and kill switch. Also covers deployment on a
  static-IP VPS in India, secrets handling, reconnect logic, and market-hours
  scheduling.
compatibility: >
  Python 3.11+, fastapi, uvicorn, dhanhq, kiteconnect, pandas, pyarrow, duckdb;
  optional redis and QuestDB/TimescaleDB. Live orders need a static IP
  registered with each broker.
---

# Trading Terminal Backend

## Service layout

```
backend/
├── app.py              # FastAPI app, lifespan starts feeds + scheduler
├── config.py           # pydantic-settings; secrets from env / .env (never in git)
├── brokers/
│   ├── base.py         # BrokerAdapter protocol, Instrument, Order, Position models
│   ├── dhan_adapter.py
│   ├── kite_adapter.py
│   └── paper.py        # simulated fills from live quotes
├── engine/             # orderflow_engine.py, greeks.py, aggregator manager
├── oms/                # order_manager.py, risk.py, journal.py
├── store/              # tick_writer.py (Parquet per day/symbol), replay.py
└── api/                # rest.py, ws.py
```

## Broker adapter contract

Both brokers sit behind one interface so the UI, OMS, and aggregators never
see broker-specific shapes.

```python
from dataclasses import dataclass
from typing import AsyncIterator, Literal, Protocol

@dataclass(frozen=True)
class Instrument:
    key: str              # canonical, e.g. "NFO:NIFTY:2026-09-29:25000:CE" or "NFO:NIFTY:FUT:2026-09-29"
    broker_ids: dict      # {"dhan": ("NSE_FNO", "49081"), "kite": 12345678}
    lot_size: int
    tick_size: float
    expiry: str | None
    strike: float | None
    opt_type: Literal["CE", "PE", "FUT", "IDX", "EQ"]

@dataclass
class OrderRequest:
    instrument: Instrument
    side: Literal["BUY", "SELL"]
    qty: int                          # shares, multiple of lot_size
    order_type: Literal["LIMIT", "MARKET", "SL", "SLM"]
    price: float | None = None
    trigger: float | None = None
    product: Literal["INTRADAY", "CARRY"] = "INTRADAY"   # Dhan INTRADAY/MARGIN, Kite MIS/NRML
    tag: str = ""

class BrokerAdapter(Protocol):
    name: str
    async def login_status(self) -> dict: ...
    async def instruments(self) -> list[Instrument]: ...
    async def subscribe(self, instruments: list[Instrument]) -> None: ...
    def ticks(self) -> AsyncIterator["Tick"]: ...           # normalized Tick stream
    async def place(self, req: OrderRequest) -> str: ...     # returns broker order id
    async def modify(self, order_id: str, **changes) -> None: ...
    async def cancel(self, order_id: str) -> None: ...
    async def orders(self) -> list[dict]: ...
    async def positions(self) -> list[dict]: ...
    async def funds(self) -> dict: ...
```

- **Instrument master**: download Dhan security list and Kite `instruments()`
  daily at ~08:30, join on (underlying, expiry, strike, type) to fill
  `broker_ids`. Store as Parquet; load into memory at start.
- Use one broker for **data** and either for **execution**; mixing is fine
  once instruments are joined (e.g. Dhan 20-level depth for orderflow, Kite
  for orders).
- Wrap blocking SDK calls with `await asyncio.to_thread(...)`.
- Dhan `MarketFeed` and Kite `KiteTicker` run their own loops/threads: push
  into an `asyncio.Queue` with `loop.call_soon_threadsafe` (see `zerodha-kite`).

## Data pipeline

```
adapter.ticks() ─> TickRouter ─┬─> TickWriter (batch 1s → Parquet / QuestDB ILP)
                               ├─> Aggregators per (symbol, stream, params)
                               │     footprint(tf,row) · profile(range,row) · tpo · cvd · vwap · candles
                               └─> OptionChainState (OI, ΔOI, IV, Greeks)
Aggregators ─> dirty-set ─> WS broadcaster (throttled 4–10 Hz per stream)
```

- Aggregators are created lazily when a client subscribes and shared across
  clients with the same params.
- On subscribe: send the full snapshot (historical bars rebuilt from stored
  ticks or broker history), then deltas: only the current bar's changed cells.
- Warm start: on boot, replay today's stored ticks so a restart mid-session
  keeps the session profile/TPO/CVD correct.

## WebSocket protocol (browser ↔ backend)

```jsonc
// client → server
{"op": "sub", "id": "fp1", "stream": "footprint", "symbol": "NFO:NIFTY:FUT:2026-09-29", "tf": "1m", "row": 5}
{"op": "unsub", "id": "fp1"}
// server → client
{"id": "fp1", "type": "snapshot", "bars": [...]}
{"id": "fp1", "type": "update", "bar": {"t": 1790000000, "o": ..., "cells": [[25005, 1200, 1875]], "delta": 675}}
{"type": "order", "data": {...}}   {"type": "position", "data": {...}}   {"type": "risk", "data": {...}}
```

Use msgpack for footprint/heatmap streams (large), JSON elsewhere.
Authenticate the WebSocket with a session cookie or short-lived JWT; the
terminal is a single-user app but still exposed to the internet.

## OMS and risk engine

Every order goes: UI ticket → REST `/orders` → risk checks → adapter → journal.

Pre-trade checks (reject with a clear reason):

- Live trading enabled flag + explicit confirmation token from the UI.
- Qty is a multiple of `lot_size`; price on `tick_size` grid; LIMIT by default.
- Max lots per order and per instrument; freeze-quantity slicing.
- Daily loss limit (realised + MTM) and max trades per day → auto-lock.
- Mandatory stop: a BUY without an attached SL is rejected (option buyer rule).
- No averaging down on losing option longs (configurable).
- Time windows: no fresh intraday entries after e.g. 15:00; auto square-off
  of INTRADAY positions at e.g. 15:15 (before the broker's own auto square-off).
- Margin check: Dhan `margin_calculator`, Kite `order_margins`.

After entry: place SL (and target) as broker orders — Dhan super order /
forever order, Kite SL order or GTT OCO for BTST — so protection survives if
the backend dies. Track via Dhan `OrderUpdate` / Kite `on_order_update`.

Kill switch: cancel all open orders, exit all positions at LIMIT with
buffer, lock new orders for the day; also call `dhan.kill_switch()` when on Dhan.

Paper broker: fill BUY at ask / SELL at bid from the live book (+ slippage
ticks), same OMS path, separate journal. Default mode.

## Storage

- Start simple: `ticks/YYYY-MM-DD/<symbol>.parquet`, query with DuckDB.
- Scale-up: QuestDB (ILP ingest, SQL `SAMPLE BY`) or TimescaleDB.
- Journal (SQLite/Postgres): orders, fills, signal id, features snapshot,
  screenshots → feeds `option-buying-ml`.
- Record option chain snapshots every minute for all strikes ±10 from ATM;
  brokers do not give history for expired options.

## Scheduling (IST)

| Time | Job |
|------|-----|
| 08:30 | token check (Kite daily login reminder), instrument master sync |
| 09:00 | pre-open snapshot, previous-day levels (VAH/VAL/POC, IB, OI) |
| 09:15–15:30 | feeds, aggregators, chain poller |
| 15:15 | intraday auto square-off (configurable) |
| 15:35 | flush ticks, EOD profiles, journal summary |

Skip NSE holidays (maintain a holiday calendar file; update yearly).

## Deployment

- VPS in Mumbai (AWS ap-south-1, etc.) with an Elastic/static IP registered
  on Dhan and Kite apps; latency to exchange-routed brokers is low there.
- Docker compose: backend, redis (optional), questdb (optional), caddy/nginx
  with TLS in front of backend + static frontend.
- Secrets in env / Docker secrets; never commit tokens; rotate Dhan token
  before `tokenValidity`.
- Health endpoint reports: feed connected, last tick age per symbol, token
  validity, risk lock state. Alert (Telegram/email) on feed stall > 10 s
  during market hours.
