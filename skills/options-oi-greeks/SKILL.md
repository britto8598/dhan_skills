---
name: options-oi-greeks
description: >
  Use for NSE/BSE index-option analytics in a trading terminal or strategy:
  Black-Scholes / Black-76 Greeks (delta, gamma, theta, vega), implied
  volatility, IV skew and IV percentile, synthetic forward, OI and change-in-OI
  by strike, OI build-up classification (long buildup, short buildup, short
  covering, long unwinding), PCR, max pain, gamma exposure (GEX) and gamma flip,
  straddle / strangle premium charts, expected move, and strike selection for
  naked option buying on NIFTY, BANKNIFTY, FINNIFTY, SENSEX with data from Dhan
  or Zerodha.
compatibility: >
  scripts/greeks.py is pure Python 3.8+ standard library. Chain data from
  dhanhq (dhan.option_chain) or zerodha-kite (instrument dump + quote/ticks).
---

# Options, OI and Greeks

Reference implementation: `scripts/greeks.py` (tested; run for a demo).

## Getting the chain

- **Dhan**: `dhan.option_chain(under_security_id=13, under_exchange_segment="IDX_I", expiry=...)`
  returns LTP, OI, volume, IV and Greeks per strike (see `dhanhq`
  `references/option-chain.md`; the endpoint is rate-limited — poll every 3 s
  at most and use MarketFeed for tick-level updates of the strikes you trade).
- **Zerodha**: no chain endpoint. Build it from `kite.instruments("NFO")`
  (filter name + expiry), subscribe the strikes around ATM on KiteTicker in
  full mode (gives `oi`), and compute IV/Greeks yourself with `greeks.py`.

Keep a time series of chain snapshots (every 1 min) — ΔOI, OI profile shifts,
straddle and IV charts all need history.

## Pricing conventions

- Underlying: prefer the **synthetic forward** `F = K + (C − P)·e^{rT}` at the
  ATM strike, or the same-expiry future. Using spot with r but no carry skews
  put/call IVs apart.
- `T` = seconds to 15:30 IST on expiry / (365·24·3600). On expiry day theta
  and gamma explode; show them but do not trust IV below ~30 minutes.
- `r` ≈ current T-bill yield (≈6–7%); its effect on weekly options is small.
- Theta per calendar day; vega per 1 vol point.
- IV solver: bisection (robust near expiry); return None when price violates
  no-arbitrage bounds (stale quotes, deep ITM).

## OI analytics

| Price | OI | Classification | Read |
|-------|----|----------------|------|
| ↑ | ↑ | Long buildup | fresh longs |
| ↓ | ↑ | Short buildup | fresh shorts (writers) |
| ↑ | ↓ | Short covering | fuel for up-moves |
| ↓ | ↓ | Long unwinding | fuel for down-moves |

Apply to the future (market bias) and to each strike (writers' zones).

- **Resistance / support by writers**: max call OI strike above spot, max put
  OI below; more meaningful when ΔOI today confirms.
- **PCR** (OI): Σ put OI / Σ call OI — use change and extremes, not absolute
  thresholds. Volume PCR is noisier but faster.
- **Max pain**: strike minimising intrinsic payout to buyers; a pin tendency
  only near expiry.
- **GEX**: Σ (call OI·Γ − put OI·Γ)·S²·1%, assuming dealers short calls /
  long puts (an assumption). Positive → mean-reverting, negative → trending;
  the flip strike is where cumulative GEX changes sign. Dhan/Kite OI is in
  shares, so pass `lot_size=1`.
- **OI profile chart**: horizontal bars of CE/PE OI per strike beside the price
  chart, with ΔOI overlay since open.

## Straddle / IV

- **ATM straddle** = CE + PE at the ATM strike (re-evaluate ATM each bar, or
  fix strike at open for a clean decay curve). Falling straddle while spot
  is range-bound = theta/IV crush → bad for buyers; rising straddle with
  expanding range = good for buyers.
- **Expected move** to expiry ≈ 0.85 × ATM straddle.
- **IV percentile / rank** over 1 year of India VIX or ATM IV — buyers want
  low-to-rising IV; avoid buying right before known IV crush (post-event).
- **Skew**: 25-delta put IV − 25-delta call IV.

## Strike selection for naked buying

- Intraday momentum: ATM or 1 strike ITM (delta 0.5–0.65) — better
  delta/theta ratio and liquidity than far OTM.
- BTST: slightly ITM of next week's expiry if current expiry is ≤1 day away
  (overnight theta on 0-DTE/1-DTE is brutal).
- Check spread (ask − bid) ≤ ~0.5–1% of premium and adequate volume/OI.
- Position size from the stop in premium terms:
  `lots = floor(risk_rupees / (sl_points × lot_size))`.
- Estimate premium move for a target on the underlying:
  `Δprem ≈ delta·ΔS + ½·gamma·ΔS² + theta·Δdays + vega·ΔIV`.
