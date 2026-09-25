---
name: zerodha-kite
description: >
  Use when the user mentions Zerodha, Kite, Kite Connect, KiteTicker, or
  pykiteconnect, or wants to trade / stream data on NSE, BSE, NFO, BFO, MCX
  through a Zerodha account. Triggers for: daily login and access-token
  generation, placing / modifying / cancelling orders (regular, AMO, cover,
  iceberg, GTT), positions, holdings, margins and order-margin calculation,
  instrument dump and NFO option symbol lookup, historical candles with OI,
  quotes, and live WebSocket ticks (ltp / quote / full with 5-level depth),
  including bridging KiteTicker into an asyncio backend for a trading terminal.
compatibility: >
  Requires Python 3.8+ and kiteconnect (pip install kiteconnect). Needs a Kite
  Connect app (api_key, api_secret) from developers.kite.trade. Live market
  data and historical candles require the paid Kite Connect plan; order APIs
  require a static IP registered on the app under SEBI's retail algo rules.
---

# Zerodha Kite Connect

## Setup and daily login

Kite access tokens expire every day (around 06:00 IST next morning). A human
must log in once per day; automating the Zerodha login form / TOTP scraping is
against Zerodha's terms — do not generate code for it.

```python
import os
from kiteconnect import KiteConnect

kite = KiteConnect(api_key=os.environ["KITE_API_KEY"])
print(kite.login_url())            # open in browser, log in
# Redirect URL receives ?request_token=XXXX&action=login&status=success
data = kite.generate_session(request_token, api_secret=os.environ["KITE_API_SECRET"])
kite.set_access_token(data["access_token"])
# Persist data["access_token"] for the day (env var, secrets file, or backend DB).
```

In a terminal backend, expose `/auth/kite/login` → redirect to `login_url()`
and `/auth/kite/callback` → `generate_session`, then store the token
server-side. Set the app's redirect URL on developers.kite.trade to that callback.

## Instruments (symbol master)

```python
import pandas as pd

nfo = pd.DataFrame(kite.instruments("NFO"))   # instrument_token, exchange_token, tradingsymbol,
                                              # name, expiry, strike, tick_size, lot_size,
                                              # instrument_type (CE/PE/FUT), segment, exchange
opts = nfo[(nfo.name == "NIFTY") & (nfo.segment == "NFO-OPT")]
nearest = opts.expiry.min()
atm = round(spot / 50) * 50
ce = opts[(opts.expiry == nearest) & (opts.strike == atm) & (opts.instrument_type == "CE")].iloc[0]
fut = nfo[(nfo.name == "NIFTY") & (nfo.segment == "NFO-FUT")].sort_values("expiry").iloc[0]
```

- Download once per day (the CSV is large); cache to disk.
- Use `lot_size` and `tick_size` from the dump. Never hardcode.
- Index tokens for spot: `NSE:NIFTY 50`, `NSE:NIFTY BANK`, `BSE:SENSEX` (look
  up their `instrument_token` in `kite.instruments("NSE")` / `("BSE")`).
- Weekly option tradingsymbols use a compact expiry code; always resolve via
  the dump instead of building strings by hand.

## Orders

```python
order_id = kite.place_order(
    variety=kite.VARIETY_REGULAR,
    exchange=kite.EXCHANGE_NFO,
    tradingsymbol=ce.tradingsymbol,
    transaction_type=kite.TRANSACTION_TYPE_BUY,
    quantity=int(ce.lot_size),          # multiples of lot_size
    product=kite.PRODUCT_MIS,           # MIS intraday, NRML carry-forward (BTST in F&O = NRML)
    order_type=kite.ORDER_TYPE_LIMIT,
    price=limit_price,
    validity=kite.VALIDITY_DAY,
    tag="term-ib-brk",                  # <=20 chars, useful for journal matching
)
kite.modify_order(kite.VARIETY_REGULAR, order_id, price=new_price)
kite.cancel_order(kite.VARIETY_REGULAR, order_id)
kite.orders(); kite.order_history(order_id); kite.trades()
kite.positions()          # {"net": [...], "day": [...]}
kite.margins("equity")
kite.order_margins([{"exchange": "NFO", "tradingsymbol": ce.tradingsymbol,
                     "transaction_type": "BUY", "variety": "regular", "product": "MIS",
                     "order_type": "LIMIT", "quantity": int(ce.lot_size), "price": limit_price}])
```

- Varieties: `regular`, `amo`, `co`, `iceberg`, `auction`. SL orders use
  `ORDER_TYPE_SL` (trigger_price + price) or `ORDER_TYPE_SLM`.
- MARKET orders for options may be rejected / converted by exchange rules on
  illiquid strikes; prefer LIMIT with a small buffer over the ask.
- GTT: `kite.place_gtt(trigger_type=kite.GTT_TYPE_SINGLE | kite.GTT_TYPE_OCO, ...)`
  for BTST stop / target that survive overnight.
- There is no broker-side kill switch API: implement it in your risk engine
  (cancel all open orders, square off positions, block new orders).
- Order postbacks: set a postback URL on the app, or poll `orders()`; the
  KiteTicker `on_order_update` callback also delivers updates.

Safety rules (same as `dhanhq`): confirm before live orders, preview, LIMIT
default, 1 lot default, validate lot multiple, credentials from env only.

## Historical data

```python
from datetime import datetime, timedelta
candles = kite.historical_data(
    instrument_token=fut.instrument_token,
    from_date=datetime.now() - timedelta(days=30),
    to_date=datetime.now(),
    interval="minute",        # minute, 3minute, 5minute, 10minute, 15minute, 30minute, 60minute, day
    continuous=False,         # True stitches expired futures (day interval only for continuous)
    oi=True,                  # adds OI column for F&O
)
```

- Per-request range limits apply (roughly 60 days for minute candles); page
  through longer ranges.
- Expired option contracts are not available from historical API — record your
  own option ticks/candles daily if you need them for backtests.

## Live ticks (KiteTicker)

```python
from kiteconnect import KiteTicker

kws = KiteTicker(api_key, access_token)

def on_ticks(ws, ticks):
    for t in ticks:  # full mode keys below
        handle(t)

def on_connect(ws, response):
    ws.subscribe(tokens)
    ws.set_mode(ws.MODE_FULL, tokens)   # MODE_LTP, MODE_QUOTE, MODE_FULL

def on_order_update(ws, data):
    oms_on_update(data)

kws.on_ticks, kws.on_connect, kws.on_order_update = on_ticks, on_connect, on_order_update
kws.connect(threaded=True)   # runs the Twisted reactor in a background thread
```

Full-mode tick fields: `instrument_token`, `last_price`,
`last_traded_quantity`, `average_traded_price`, `volume_traded`,
`total_buy_quantity`, `total_sell_quantity`, `ohlc{open,high,low,close}`,
`change`, `last_trade_time`, `exchange_timestamp`, `oi`, `oi_day_high`,
`oi_day_low`, `depth{buy[5], sell[5]}` each `{price, quantity, orders}`.
Index tokens send fewer fields (no volume / depth).

Limits: up to 3000 instruments per connection and 3 connections per api_key.

### Bridge to asyncio (terminal backend)

KiteTicker runs on Twisted in its own thread. Never do heavy work in
`on_ticks`; hand off to the asyncio loop:

```python
import asyncio
from orderflow_engine import Tick   # from the orderflow-indicators skill

loop = asyncio.get_event_loop()
queue: asyncio.Queue = asyncio.Queue(maxsize=100_000)
token_to_symbol = {...}

def on_ticks(ws, ticks):
    for t in ticks:
        d = t.get("depth") or {}
        bid = d.get("buy", [{}])[0]; ask = d.get("sell", [{}])[0]
        tick = Tick(
            ts=t.get("exchange_timestamp") or t.get("last_trade_time"),
            symbol=token_to_symbol[t["instrument_token"]],
            ltp=t["last_price"],
            cum_volume=t.get("volume_traded", 0),
            bid=bid.get("price") or None, ask=ask.get("price") or None,
            bid_qty=bid.get("quantity", 0), ask_qty=ask.get("quantity", 0),
            oi=t.get("oi"),
        )
        loop.call_soon_threadsafe(queue.put_nowait, tick)
```

Reconnect: KiteTicker auto-reconnects (`reconnect=True`,
`reconnect_max_tries`, `reconnect_max_delay`). After reconnect, re-subscribe in
`on_connect` and reset the trade classifier's previous snapshot for affected
symbols so the first volume delta is not counted as one giant trade.

## Rate limits (approximate — verify on the docs)

| API | Limit |
|-----|-------|
| Quote (`quote`, `ltp`, `ohlc`) | ~1 req/s, up to 500 instruments per call |
| Historical | ~3 req/s |
| Order placement | ~10 req/s, with per-minute and per-day caps |
| Other endpoints | ~10 req/s |

## Common errors

| Exception | Meaning |
|-----------|---------|
| `TokenException` | access token expired / invalid — redo login |
| `InputException` | bad params (lot multiple, tick size, symbol) |
| `OrderException` | RMS rejection (margin, circuit, freeze qty) |
| `NetworkException` | timeout / 429 — back off and retry idempotently (check `orders()` by `tag` before re-sending) |
| `PermissionException` | app not subscribed to the data plan, or static IP not whitelisted |

Docs: https://kite.trade/docs/connect/v3/ · SDK: https://github.com/zerodha/pykiteconnect
