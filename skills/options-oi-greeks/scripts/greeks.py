"""
Option analytics for NSE index options (NIFTY / BANKNIFTY / SENSEX): Black-Scholes
price + Greeks, implied volatility, OI build-up, PCR, max pain, GEX, straddle.

Pure standard library. Run `python greeks.py` for a demo.

Conventions:
- T is in years; expiry is 15:30 IST on expiry day.
- Theta is per calendar day, vega per 1 vol point (1%), rho per 1% rate.
- For index options use the synthetic forward (put-call parity) or the futures
  price as the underlying with r used only for discounting (Black-76 style) to
  avoid the dividend / cost-of-carry guess.
"""

from __future__ import annotations

import math
from datetime import datetime, time
from typing import Dict, Iterable, List, Optional

SQRT2PI = math.sqrt(2 * math.pi)
EXPIRY_TIME = time(15, 30)


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT2PI


def year_fraction(now: datetime, expiry_date: datetime) -> float:
    exp = datetime.combine(expiry_date.date(), EXPIRY_TIME)
    return max((exp - now).total_seconds(), 0.0) / (365 * 24 * 3600)


def _d1d2(S: float, K: float, T: float, r: float, sigma: float, q: float):
    vt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vt
    return d1, d1 - vt


def bs_price(S: float, K: float, T: float, r: float, sigma: float, cp: str, q: float = 0.0) -> float:
    if T <= 0 or sigma <= 0:
        return max(S - K, 0.0) if cp == "CE" else max(K - S, 0.0)
    d1, d2 = _d1d2(S, K, T, r, sigma, q)
    if cp == "CE":
        return S * math.exp(-q * T) * ncdf(d1) - K * math.exp(-r * T) * ncdf(d2)
    return K * math.exp(-r * T) * ncdf(-d2) - S * math.exp(-q * T) * ncdf(-d1)


def greeks(S: float, K: float, T: float, r: float, sigma: float, cp: str, q: float = 0.0) -> Dict[str, float]:
    if T <= 0 or sigma <= 0:
        itm = (S > K) if cp == "CE" else (S < K)
        return {"price": bs_price(S, K, T, r, sigma, cp, q), "delta": (1.0 if cp == "CE" else -1.0) if itm else 0.0,
                "gamma": 0.0, "theta": 0.0, "vega": 0.0, "rho": 0.0}
    d1, d2 = _d1d2(S, K, T, r, sigma, q)
    dq, dr, sq = math.exp(-q * T), math.exp(-r * T), math.sqrt(T)
    gamma = dq * npdf(d1) / (S * sigma * sq)
    vega = S * dq * npdf(d1) * sq / 100
    common = -S * dq * npdf(d1) * sigma / (2 * sq)
    if cp == "CE":
        delta = dq * ncdf(d1)
        theta = common - r * K * dr * ncdf(d2) + q * S * dq * ncdf(d1)
        rho = K * T * dr * ncdf(d2) / 100
    else:
        delta = -dq * ncdf(-d1)
        theta = common + r * K * dr * ncdf(-d2) - q * S * dq * ncdf(-d1)
        rho = -K * T * dr * ncdf(-d2) / 100
    return {"price": bs_price(S, K, T, r, sigma, cp, q), "delta": delta, "gamma": gamma,
            "theta": theta / 365, "vega": vega, "rho": rho}


def implied_vol(price: float, S: float, K: float, T: float, r: float, cp: str, q: float = 0.0,
                lo: float = 1e-4, hi: float = 5.0, tol: float = 1e-6) -> Optional[float]:
    """Bisection (robust near expiry where Newton blows up). None if price is outside no-arb bounds."""
    if T <= 0 or price <= 0:
        return None
    if not (bs_price(S, K, T, r, lo, cp, q) <= price <= bs_price(S, K, T, r, hi, cp, q)):
        return None
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if bs_price(S, K, T, r, mid, cp, q) > price:
            hi = mid
        else:
            lo = mid
        if hi - lo < tol:
            break
    return 0.5 * (lo + hi)


def synthetic_forward(K: float, ce: float, pe: float, T: float, r: float) -> float:
    """Put-call parity at (ideally) the ATM strike: F = K + (C - P) * e^{rT}."""
    return K + (ce - pe) * math.exp(r * T)


# --------------------------------------------------------------------------- #
# OI analytics
# --------------------------------------------------------------------------- #
def oi_buildup(price_chg: float, oi_chg: float) -> str:
    if price_chg > 0 and oi_chg > 0:
        return "LONG_BUILDUP"
    if price_chg < 0 and oi_chg > 0:
        return "SHORT_BUILDUP"
    if price_chg > 0 and oi_chg < 0:
        return "SHORT_COVERING"
    if price_chg < 0 and oi_chg < 0:
        return "LONG_UNWINDING"
    return "NEUTRAL"


def pcr(chain: Iterable[Dict]) -> float:
    rows = list(chain)
    ce = sum(r["ce_oi"] for r in rows)
    return sum(r["pe_oi"] for r in rows) / ce if ce else float("nan")


def max_pain(chain: Iterable[Dict]) -> float:
    """Strike where total intrinsic payout to option buyers is minimum."""
    rows = list(chain)
    strikes = [r["strike"] for r in rows]

    def pain(x: float) -> float:
        return sum(max(x - r["strike"], 0) * r["ce_oi"] + max(r["strike"] - x, 0) * r["pe_oi"] for r in rows)

    return min(strikes, key=pain)


def gex(chain: Iterable[Dict], S: float, T: float, r: float, lot_size: int) -> Dict[str, float]:
    """
    Dealer gamma exposure per 1% move, assuming dealers are short calls & long puts
    (the common retail-flow assumption; it is an assumption, not observed positioning).
    Rows need strike, ce_oi, pe_oi, ce_iv, pe_iv (IV as decimals). OI in contracts or
    shares -- set lot_size=1 if OI is already in shares (Dhan/Kite report shares).
    """
    by_strike, total = {}, 0.0
    for row in chain:
        K = row["strike"]
        g_ce = greeks(S, K, T, r, row["ce_iv"], "CE")["gamma"] if row.get("ce_iv") else 0.0
        g_pe = greeks(S, K, T, r, row["pe_iv"], "PE")["gamma"] if row.get("pe_iv") else 0.0
        val = (row["ce_oi"] * g_ce - row["pe_oi"] * g_pe) * lot_size * S * S * 0.01
        by_strike[K] = val
        total += val
    flip = None
    running = 0.0
    for K in sorted(by_strike):
        prev, running = running, running + by_strike[K]
        if prev < 0 <= running or prev > 0 >= running:
            flip = K
    return {"total": total, "flip_strike": flip, "by_strike": by_strike}


def straddle_series(ce: List[float], pe: List[float]) -> List[float]:
    """ATM CE + PE premium per bar. Falling straddle = premium decay (bad for buyers)."""
    return [c + p for c, p in zip(ce, pe)]


def expected_move(straddle_premium: float) -> float:
    """~0.8-0.85 x ATM straddle approximates the 1-sigma move to expiry."""
    return 0.85 * straddle_premium


def _demo() -> None:
    now, exp = datetime(2026, 9, 25, 10, 0), datetime(2026, 9, 29)
    S, r, T = 25000.0, 0.065, year_fraction(now, exp)
    g = greeks(S, 25000, T, r, 0.12, "CE")
    print("T(years)=%.5f ATM CE:" % T, {k: round(v, 4) for k, v in g.items()})
    iv = implied_vol(g["price"], S, 25000, T, r, "CE")
    print("IV round-trip:", round(iv, 4))
    chain = [
        {"strike": 24800, "ce_oi": 20e5, "pe_oi": 90e5, "ce_iv": 0.13, "pe_iv": 0.14},
        {"strike": 24900, "ce_oi": 35e5, "pe_oi": 80e5, "ce_iv": 0.125, "pe_iv": 0.13},
        {"strike": 25000, "ce_oi": 95e5, "pe_oi": 85e5, "ce_iv": 0.12, "pe_iv": 0.125},
        {"strike": 25100, "ce_oi": 110e5, "pe_oi": 30e5, "ce_iv": 0.118, "pe_iv": 0.12},
        {"strike": 25200, "ce_oi": 120e5, "pe_oi": 15e5, "ce_iv": 0.117, "pe_iv": 0.12},
    ]
    print("PCR:", round(pcr(chain), 3), "| max pain:", max_pain(chain))
    gx = gex(chain, S, T, r, lot_size=1)
    print("GEX total (per 1%%): %.3e flip: %s" % (gx["total"], gx["flip_strike"]))
    print("buildup:", oi_buildup(+12.5, +150000), oi_buildup(-8, -90000))


if __name__ == "__main__":
    _demo()
