"""
Broker-agnostic orderflow engine for Indian markets (Dhan / Zerodha snapshot feeds).

NSE does not give retail APIs tick-by-tick trades. Dhan MarketFeed and Kite
KiteTicker send *snapshots* (LTP, cumulative volume, best bid/ask). This module
reconstructs approximate trades from consecutive snapshots and builds:

- Footprint bars (bid x ask volume per price level, delta, imbalances)
- Volume profile (POC / VAH / VAL)
- TPO / Market Profile (letters, IB, POC, VA, single prints, poor high/low)
- CVD, VWAP with standard-deviation bands, big-trade detection

Pure standard library. Run `python orderflow_engine.py` for a synthetic demo.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Dict, Iterable, List, Optional, Tuple

BUY, SELL = 1, -1
TPO_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
NSE_OPEN = time(9, 15)


# --------------------------------------------------------------------------- #
# Normalized tick + trade reconstruction
# --------------------------------------------------------------------------- #
@dataclass
class Tick:
    """Broker-neutral snapshot. Map Dhan/Kite packets into this first."""
    ts: datetime              # exchange timestamp (IST, naive or aware)
    symbol: str
    ltp: float
    cum_volume: int           # day cumulative volume (Dhan `volume`, Kite `volume_traded`)
    bid: Optional[float] = None
    ask: Optional[float] = None
    bid_qty: int = 0
    ask_qty: int = 0
    oi: Optional[int] = None


@dataclass
class Trade:
    ts: datetime
    symbol: str
    price: float
    qty: int
    side: int                 # BUY (+1, lifted ask) or SELL (-1, hit bid)


class TradeClassifier:
    """Quote rule first, tick rule as fallback (Lee-Ready adapted for snapshots)."""

    def __init__(self) -> None:
        self._prev: Dict[str, Tick] = {}
        self._last_side: Dict[str, int] = {}

    def on_tick(self, t: Tick) -> Optional[Trade]:
        prev = self._prev.get(t.symbol)
        self._prev[t.symbol] = t
        if prev is None:
            return None
        dv = t.cum_volume - prev.cum_volume
        if dv <= 0:                       # no new volume, or day reset / reconnect
            return None
        side = self._classify(t, prev)
        self._last_side[t.symbol] = side
        return Trade(t.ts, t.symbol, t.ltp, dv, side)

    def _classify(self, t: Tick, prev: Tick) -> int:
        if prev.ask is not None and t.ltp >= prev.ask:
            return BUY
        if prev.bid is not None and t.ltp <= prev.bid:
            return SELL
        if t.ltp > prev.ltp:
            return BUY
        if t.ltp < prev.ltp:
            return SELL
        return self._last_side.get(t.symbol, BUY)


def bucket(price: float, size: float) -> float:
    """Snap a price to its row (e.g. size=5 for NIFTY futures footprint rows)."""
    return round(math.floor(price / size + 1e-9) * size, 6)


def floor_time(ts: datetime, minutes: int, session_open: time = NSE_OPEN) -> datetime:
    """Bar start aligned to the NSE session open (09:15), not to the clock hour."""
    anchor = ts.replace(hour=session_open.hour, minute=session_open.minute, second=0, microsecond=0)
    n = int((ts - anchor).total_seconds() // (minutes * 60))
    return anchor + timedelta(minutes=n * minutes)


# --------------------------------------------------------------------------- #
# Footprint
# --------------------------------------------------------------------------- #
@dataclass
class FootprintBar:
    start: datetime
    open: float = 0.0
    high: float = -math.inf
    low: float = math.inf
    close: float = 0.0
    levels: Dict[float, List[int]] = field(default_factory=lambda: defaultdict(lambda: [0, 0]))  # price -> [bid_vol, ask_vol]

    @property
    def volume(self) -> int:
        return sum(b + a for b, a in self.levels.values())

    @property
    def delta(self) -> int:
        return sum(a - b for b, a in self.levels.values())

    def poc(self) -> Optional[float]:
        if not self.levels:
            return None
        return max(self.levels, key=lambda p: sum(self.levels[p]))

    def imbalances(self, row: float, ratio: float = 3.0, min_vol: int = 1) -> Dict[str, List[float]]:
        """Diagonal imbalance: ask@p vs bid@(p-row) for buys, bid@p vs ask@(p+row) for sells."""
        buy, sell = [], []
        for p, (b, a) in self.levels.items():
            below_bid = self.levels[p - row][0] if (p - row) in self.levels else 0
            above_ask = self.levels[p + row][1] if (p + row) in self.levels else 0
            if a >= min_vol and a >= ratio * max(below_bid, 1):
                buy.append(p)
            if b >= min_vol and b >= ratio * max(above_ask, 1):
                sell.append(p)
        return {"buy": sorted(buy), "sell": sorted(sell)}

    def stacked(self, prices: List[float], row: float, n: int = 3) -> List[Tuple[float, float]]:
        """Runs of >= n consecutive imbalance rows -> [(low, high), ...]."""
        runs, start, prev = [], None, None
        for p in sorted(prices):
            if prev is not None and abs(p - prev - row) < 1e-9:
                prev = p
                continue
            if start is not None and round((prev - start) / row) + 1 >= n:
                runs.append((start, prev))
            start = prev = p
        if start is not None and round((prev - start) / row) + 1 >= n:
            runs.append((start, prev))
        return runs


class FootprintBuilder:
    def __init__(self, minutes: int = 1, row: float = 5.0) -> None:
        self.minutes, self.row = minutes, row
        self.bars: List[FootprintBar] = []

    def on_trade(self, tr: Trade) -> FootprintBar:
        start = floor_time(tr.ts, self.minutes)
        if not self.bars or self.bars[-1].start != start:
            self.bars.append(FootprintBar(start=start, open=tr.price))
        bar = self.bars[-1]
        bar.high, bar.low, bar.close = max(bar.high, tr.price), min(bar.low, tr.price), tr.price
        cell = bar.levels[bucket(tr.price, self.row)]
        cell[0 if tr.side == SELL else 1] += tr.qty
        return bar


# --------------------------------------------------------------------------- #
# Volume profile
# --------------------------------------------------------------------------- #
def value_area(hist: Dict[float, float], row: float, pct: float = 0.70) -> Tuple[float, float, float]:
    """Return (POC, VAL, VAH). Expands from POC one row at a time toward the heavier side."""
    if not hist:
        raise ValueError("empty profile")
    prices = sorted(hist)
    poc = max(prices, key=lambda p: (hist[p], -abs(p - (prices[0] + prices[-1]) / 2)))
    target, acc = pct * sum(hist.values()), hist[poc]
    lo = hi = poc
    while acc < target and (lo > prices[0] or hi < prices[-1]):
        up = hist.get(round(hi + row, 6), 0) if hi < prices[-1] else -1
        dn = hist.get(round(lo - row, 6), 0) if lo > prices[0] else -1
        if up >= dn:
            hi = round(hi + row, 6)
            acc += max(up, 0)
        else:
            lo = round(lo - row, 6)
            acc += max(dn, 0)
    return poc, lo, hi


class VolumeProfile:
    def __init__(self, row: float = 5.0) -> None:
        self.row = row
        self.hist: Dict[float, int] = defaultdict(int)
        self.delta: Dict[float, int] = defaultdict(int)

    def on_trade(self, tr: Trade) -> None:
        p = bucket(tr.price, self.row)
        self.hist[p] += tr.qty
        self.delta[p] += tr.qty * tr.side

    def levels(self, pct: float = 0.70) -> Dict[str, float]:
        poc, val, vah = value_area(self.hist, self.row, pct)
        return {"poc": poc, "val": val, "vah": vah}

    def hvn_lvn(self, window: int = 2) -> Dict[str, List[float]]:
        """Local maxima (HVN) / minima (LVN) over +-window rows."""
        ps = sorted(self.hist)
        hv, lv = [], []
        for i, p in enumerate(ps):
            nb = [self.hist[q] for q in ps[max(0, i - window): i + window + 1] if q != p]
            if nb and self.hist[p] > max(nb):
                hv.append(p)
            if nb and self.hist[p] < min(nb):
                lv.append(p)
        return {"hvn": hv, "lvn": lv}


# --------------------------------------------------------------------------- #
# TPO / Market Profile
# --------------------------------------------------------------------------- #
@dataclass
class Candle:
    ts: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int = 0


class TPOProfile:
    """30-min TPO letters from 1-min (or any <=30-min) candles. NSE: A=09:15, B=09:45, ..."""

    def __init__(self, row: float = 5.0, period_min: int = 30, ib_periods: int = 2) -> None:
        self.row, self.period_min, self.ib_periods = row, period_min, ib_periods
        self.letters: Dict[float, str] = defaultdict(str)
        self.period_hilo: Dict[int, Tuple[float, float]] = {}
        self.open: Optional[float] = None

    def on_candle(self, c: Candle) -> None:
        if self.open is None:
            self.open = c.open
        idx = int((c.ts - floor_time(c.ts, 24 * 60)).total_seconds() // (self.period_min * 60))
        hi, lo = self.period_hilo.get(idx, (-math.inf, math.inf))
        self.period_hilo[idx] = (max(hi, c.high), min(lo, c.low))
        letter = TPO_LETTERS[idx % len(TPO_LETTERS)]
        p = bucket(c.low, self.row)
        while p <= c.high + 1e-9:
            if letter not in self.letters[p]:
                self.letters[p] += letter
            p = round(p + self.row, 6)

    def summary(self) -> Dict[str, object]:
        counts = {p: len(s) for p, s in self.letters.items()}
        poc, val, vah = value_area(counts, self.row)
        ps = sorted(counts)
        ib = [self.period_hilo[i] for i in sorted(self.period_hilo)[: self.ib_periods]]
        ib_high, ib_low = max(h for h, _ in ib), min(l for _, l in ib)
        return {
            "poc": poc, "val": val, "vah": vah,
            "ib_high": ib_high, "ib_low": ib_low,
            "single_prints": [p for p in ps if counts[p] == 1 and ps[0] < p < ps[-1]],
            "poor_high": counts[ps[-1]] >= 2,   # >=2 TPOs at the extreme = unfinished auction
            "poor_low": counts[ps[0]] >= 2,
            "range_ext_up": max(h for h, _ in self.period_hilo.values()) > ib_high,
            "range_ext_down": min(l for _, l in self.period_hilo.values()) < ib_low,
        }

    def render(self) -> str:
        return "\n".join(f"{p:>10.2f} {self.letters[p]}" for p in sorted(self.letters, reverse=True))


# --------------------------------------------------------------------------- #
# CVD, VWAP, big trades
# --------------------------------------------------------------------------- #
class CVD:
    def __init__(self) -> None:
        self.value = 0
        self.series: List[Tuple[datetime, int]] = []

    def on_trade(self, tr: Trade) -> int:
        self.value += tr.qty * tr.side
        self.series.append((tr.ts, self.value))
        return self.value


class VWAP:
    """Session VWAP with volume-weighted standard-deviation bands."""

    def __init__(self) -> None:
        self.pv = self.v = self.p2v = 0.0

    def on_trade(self, tr: Trade) -> None:
        self.pv += tr.price * tr.qty
        self.p2v += tr.price * tr.price * tr.qty
        self.v += tr.qty

    def bands(self, k: Iterable[float] = (1, 2)) -> Dict[str, float]:
        vwap = self.pv / self.v
        sd = math.sqrt(max(self.p2v / self.v - vwap * vwap, 0.0))
        out = {"vwap": vwap}
        for m in k:
            out[f"+{m}sd"], out[f"-{m}sd"] = vwap + m * sd, vwap - m * sd
        return out


def big_trades(trades: Iterable[Trade], min_qty: int) -> List[Trade]:
    """Snapshot deltas >= min_qty (use lot_size * N). Aggregated prints, not single orders."""
    return [t for t in trades if t.qty >= min_qty]


# --------------------------------------------------------------------------- #
# Demo
# --------------------------------------------------------------------------- #
def _demo() -> None:
    import random

    random.seed(7)
    clf, fp, vp, cvd, vw = TradeClassifier(), FootprintBuilder(1, 5.0), VolumeProfile(5.0), CVD(), VWAP()
    trades: List[Trade] = []
    ts, price, vol = datetime(2026, 9, 25, 9, 15), 25000.0, 0
    for _ in range(3000):
        ts += timedelta(seconds=random.choice([1, 1, 2]))
        price = round(price + random.choice([-0.05, 0, 0.05]) * random.randint(1, 60), 2)
        vol += random.choice([0, 75, 150, 75 * random.randint(1, 20)])
        tr = clf.on_tick(Tick(ts, "NIFTY-FUT", price, vol, price - 0.5, price + 0.5))
        if tr:
            trades.append(tr)
            fp.on_trade(tr); vp.on_trade(tr); cvd.on_trade(tr); vw.on_trade(tr)

    last = fp.bars[-1]
    imb = last.imbalances(5.0)
    print(f"bars={len(fp.bars)} last={last.start:%H:%M} O{last.open} H{last.high} L{last.low} C{last.close} "
          f"vol={last.volume} delta={last.delta} poc={last.poc()}")
    print("imbalances:", imb, "stacked buy:", last.stacked(imb["buy"], 5.0))
    print("volume profile:", vp.levels(), "| CVD:", cvd.value, "| VWAP:", {k: round(v, 2) for k, v in vw.bands().items()})
    print("big trades (>=15 lots):", len(big_trades(trades, 75 * 15)))

    tpo = TPOProfile(row=10.0)
    for b in fp.bars:
        tpo.on_candle(Candle(b.start, b.open, b.high, b.low, b.close, b.volume))
    print("TPO:", tpo.summary())


if __name__ == "__main__":
    _demo()
