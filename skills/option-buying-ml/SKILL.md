---
name: option-buying-ml
description: >
  Use when designing, backtesting, or training machine-learning filters for
  NIFTY / BANKNIFTY / SENSEX intraday and BTST naked option buying based on
  TPO / market-profile key levels, orderflow (delta, CVD, imbalances), OI
  build-up, and Greeks/IV. Covers turning rule-based setups into labelled
  events, feature engineering without look-ahead, triple-barrier labels on
  option premium, Indian F&O cost model, walk-forward / purged validation,
  meta-labelling with LightGBM, probability calibration, position sizing,
  and a journal feedback loop that retrains the model on the user's own trades.
compatibility: >
  Python 3.10+, pandas, numpy, lightgbm, scikit-learn, shap (optional), duckdb.
  Needs stored ticks/candles for the future and the traded option strikes
  (see trading-terminal-backend storage) plus orderflow-indicators and
  options-oi-greeks for features.
---

# ML for Naked Option Buying

Principle: **rules find the setup, ML decides whether to take it and how big.**
Predicting raw next-bar direction on NIFTY is close to a coin flip; filtering
a setup that already has a structural edge (meta-labelling) is far more
robust. No model makes option buying guaranteed-profitable — judge everything
by expectancy after costs on out-of-sample days.

## 1. Setups (event generators)

Encode each discretionary setup as a deterministic function that emits an
event at bar close with direction (CE/PE), underlying stop, and underlying target:

| Setup | Trigger (example) |
|-------|-------------------|
| IB breakout | close outside IB after 10:15 with delta confirming and CVD making new session high/low |
| Value-area rejection | open inside prev VA, test of pVAH/pVAL with sell/buy imbalance stack, back into VA |
| 80% rule | open outside prev VA, re-enter and hold 2 TPO periods → target other side of VA |
| Naked POC / single-print fill | move toward untested prior POC or single-print zone |
| Absorption reversal | big passive volume at extreme + delta divergence at key level |
| OI shift | spot crosses max-ΔOI strike with short covering on that strike |
| BTST | close near day high, trend day / range extension up, rising future OI (long buildup), IV not elevated |

## 2. Features (only what was known at the event time)

| Group | Examples |
|-------|----------|
| Auction / TPO | position vs prev VAH/VAL/POC (in ATR units), IB width / 20-day avg IB, open type, day-type so far, single prints above/below, poor high/low flags, distance to naked POCs |
| Volume profile | developing POC migration (slope), price vs developing VA, LVN/HVN distance |
| Orderflow | bar delta, delta %, CVD slope (5/15 bars), CVD–price divergence flag, stacked imbalance count/direction, big-trade qty last N bars, absorption score |
| Futures OI | ΔOI since open, build-up class last 15 min, basis (fut − spot) change |
| Options | PCR change, ATM IV, IV percentile, straddle change since open, max-OI CE/PE distance, GEX sign, chosen strike's delta/gamma/theta, bid-ask spread % |
| Context | minutes since open, DTE, India VIX level/change, gap %, prev day range, weekday, event day flag |

Rules against leakage:

- Use **developing** VA/POC/TPO counts at time t, never the final day profile.
- Build features with the same replay code the live terminal uses.
- Normalise by ATR or IB width, not raw points, so regimes are comparable.

## 3. Labels — triple barrier on the option premium

Simulate the actual trade, not the index:

1. Pick the strike your live rule would pick (e.g. ATM / 1-ITM, nearest weekly
   with DTE ≥ 1 for BTST).
2. Entry = ask at next tick after signal (+ slippage ticks).
3. Barriers: target (e.g. +30% premium or underlying target), stop (−20%
   premium or underlying stop), time (e.g. 45 min intraday; next day 09:45 for BTST).
4. Exit = bid when a barrier is touched (+ slippage).
5. Label `y = 1` if net P&L after costs > 0 (or target hit first); keep the
   ₹ P&L as the regression / evaluation target.

If option ticks are missing for old dates, reprice with `greeks.py` from the
future + recorded ATM IV, and mark those rows as synthetic (lower weight).

## 4. Cost model (verify current rates before use)

Per option round trip (buy then sell):

- Brokerage: ₹20 per executed order on Dhan and Zerodha → ₹40.
- STT: 0.1% of premium on the **sell** side.
- Exchange transaction charge on premium (NSE ≈ 0.035%), both sides.
- SEBI fee ₹10/crore; stamp duty 0.003% on buy side.
- GST 18% on brokerage + exchange + SEBI charges.
- Slippage: ≥1–2 ticks each side on liquid ATM strikes; more on expiry day spikes.

Small-premium scalps can be dominated by these costs — always report
gross vs net.

## 5. Validation

- **Walk-forward by day**: train on months 1..k, test on month k+1, roll.
  Never shuffle bars across days.
- **Purge + embargo**: drop training events whose label window overlaps the
  test window; embargo ~1 day after each test block.
- Enough events: aim for ≥ 300–500 events per setup before trusting a model;
  otherwise use the model only for ranking, or stay rules-only.
- Metrics: expectancy ₹/trade, profit factor, win rate *with* avg win/avg
  loss, max drawdown, trades/day, % of days positive. Accuracy/AUC are
  secondary.
- Baselines: take-every-signal, and random-skip at the same take rate. The
  model must beat both out of sample.

## 6. Model

```python
import lightgbm as lgb
from sklearn.calibration import CalibratedClassifierCV

model = lgb.LGBMClassifier(n_estimators=400, learning_rate=0.03, num_leaves=15,
                           min_child_samples=40, subsample=0.8, subsample_freq=1,
                           colsample_bytree=0.8, reg_lambda=1.0)
clf = CalibratedClassifierCV(model, method="isotonic", cv=3)   # inside each walk-forward fold
clf.fit(X_train, y_train)
p = clf.predict_proba(X_test)[:, 1]
```

- Choose the take-threshold on the **validation** fold by maximising
  expectancy, then freeze it for the test fold.
- Size: `lots = base_lots × clip((p − threshold) / (p_max − threshold), 0, 1)`,
  capped by the risk engine's max loss.
- Explain with SHAP; drop features whose importance flips sign between folds.
- Shallow trees + strong regularisation: financial data is small and noisy.

## 7. Journal feedback loop ("teaching" the system)

1. Every signal (taken or skipped) is logged with its feature vector, model
   probability, and the rule version.
2. Fills and exits come from the OMS journal; outcome labels are computed
   automatically after the time barrier.
3. Weekly job: append new labelled events, re-run walk-forward, compare with
   the live model; promote only if out-of-sample expectancy improves and
   drawdown does not worsen.
4. Drift monitor: feature distribution shift (PSI) and rolling live
   expectancy vs backtest band; auto-reduce size when outside the band.
5. Show the probability and the top SHAP reasons on the order ticket so the
   trader learns which context matters.

## 8. Discipline rules to encode (option buyer)

- Fixed ₹ risk per trade; hard daily loss limit; stop after N consecutive losses.
- No trades in the first 5 minutes unless the setup is an open-drive.
- Avoid expiry-day far-OTM lottery buys unless the setup explicitly targets
  gamma expansion with tight time stops.
- Exit on time if the move doesn't come — theta is the buyer's enemy.
