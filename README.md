# DhanHQ Agent Skills

Use DhanHQ APIs inside AI agents like Claude Code, Codex or any other agent of your choice.

**Dhan-native agent skill for NSE/BSE equities, F&O, and commodity trading.**

Give your AI agent the ability to place live orders, read real portfolio data, stream market feeds, and access the full instrument universe of Indian exchanges — all through [DhanHQ's APIs](https://api.dhan.co/v2/#/).

Built for the [Agent Skills open standard](https://agentskills.io) and compatible with Claude Code, Codex, and any agent that supports SKILL.md.

---

## Installation

**You don’t need to clone the repository. Install the skill directly with `npx`.**

### Global install

```bash
npm install -g skills
skills add dhan-oss/dhanhq-skills --skill dhanhq
```

### Claude Code or Codex

```bash
npx skills add dhan-oss/dhanhq-skills --skill dhanhq
```

OR 

```bash
npx @dhan-oss/dhanhq-skill
```

---

## Trading Terminal Skills (Dhan + Zerodha)

Extra skills in this repo for building a self-hosted, browser-based orderflow
terminal (ODXCharts-style web terminal with Quantower-style indicators) for
NIFTY / BANKNIFTY / SENSEX futures and options.

| Skill | Purpose |
|-------|---------|
| [`trading-terminal-blueprint`](skills/trading-terminal-blueprint/SKILL.md) | Entry point: architecture, feature map, build phases, which skill to use |
| [`dhanhq`](skills/dhanhq/SKILL.md) | Dhan orders, option chain, MarketFeed, 20/200-level depth |
| [`zerodha-kite`](skills/zerodha-kite/SKILL.md) | Kite Connect login, instruments, orders, GTT, KiteTicker → asyncio |
| [`orderflow-indicators`](skills/orderflow-indicators/SKILL.md) | Trade reconstruction from snapshots, footprint, volume profile, TPO, CVD, VWAP, big trades, heatmap (`scripts/orderflow_engine.py`) |
| [`options-oi-greeks`](skills/options-oi-greeks/SKILL.md) | Greeks, IV, OI build-up, PCR, max pain, GEX, straddle, strike selection (`scripts/greeks.py`) |
| [`trading-terminal-backend`](skills/trading-terminal-backend/SKILL.md) | FastAPI relay, broker adapters, tick store, WebSocket protocol, OMS, risk engine, paper broker, deployment |
| [`browser-terminal-frontend`](skills/browser-terminal-frontend/SKILL.md) | React + lightweight-charts, canvas footprint/TPO/heatmap, DOM ladder, option chain, order ticket |
| [`option-buying-ml`](skills/option-buying-ml/SKILL.md) | Setups → labelled events, leak-free features, triple-barrier labels, cost model, walk-forward LightGBM meta-labelling, journal feedback loop |

Install one or more:

```bash
npx skills add britto8598/dhan_skills --skill trading-terminal-blueprint
npx skills add britto8598/dhan_skills --skill orderflow-indicators
# ...repeat for each skill you need
```

**Claude Code on the web / opening this repo:** nothing to install. `.claude/skills/`
holds symlinks to every folder in `skills/`, so any Claude Code session started in
this repo loads all the skills automatically. Edit skills only under `skills/`.

Or copy folders straight into Claude Code's skill directory (to use them in other projects):

```bash
git clone -b claude/trading-odxcharts-terminal-b0wmgg https://github.com/britto8598/dhan_skills.git
cd dhan_skills
mkdir -p ~/.claude/skills && cp -r skills/* ~/.claude/skills/     # macOS / Linux, all projects
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills" | Out-Null
Copy-Item -Recurse -Force skills\* "$env:USERPROFILE\.claude\skills\"
```

Then ask Claude Code, e.g. *"Using trading-terminal-blueprint, scaffold phase 1:
Dhan + Kite feeds into normalized ticks and a NIFTY-I footprint aggregator."*

---
## After Installation

Once installed, your AI agent can automatically use the `dhanhq` skill when your prompt involves DhanHQ APIs, Indian market data, portfolio, orders, funds, or trading workflows.

Example prompts:

- Show my holdings
- Get daily OHLC for RELIANCE for the last 6 months
- Show Nifty option chain for nearest expiry
- Check margin required to sell 1 lot of Nifty

## Requirements

- Python 3.8+ and `pip install dhanhq`
- **Order APIs**: static IP whitelisting on Dhan required
- **Data APIs**: active Dhan Data Plan required
- Credentials via environment variables: `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN`

---

## What's Included

```
skills/
└── dhanhq/
    ├── SKILL.md                          # Entry point — setup, safety rules, core patterns
    │
    ├── references/                       # Deep-dive docs loaded on demand
    │   ├── orders.md                     # Order lifecycle (regular, super, forever, AMO)
    │   ├── portfolio.md                  # Holdings, positions, convert position, eDIS
    │   ├── market-data.md                # Historical OHLC, intraday, quotes
    │   ├── option-chain.md               # Option chain with Greeks, expiry list
    │   ├── instruments.md                # Security master, symbol resolution
    │   ├── funds.md                      # Fund limits and margin calculator
    │   ├── live-feed.md                  # WebSocket: MarketFeed, OrderUpdate, FullDepth
    │   ├── error-codes.md                # Error codes, rate limits, retry patterns
    │   ├── scanx-data.md                 # ScanX real-time scanner data
    │   ├── common-workflows.md           # Multi-step patterns (rebalance, iron condor, P&L)
    │   ├── options-analysis-patterns.md  # PCR, max pain, payoff diagrams, IV skew
    │   └── backtesting-with-dhan.md      # Equity + F&O backtest patterns with cost model
    │
    ├── scripts/
    │   ├── dhan_helpers.py               # Composable helper library
    │   ├── resolve_security.py           # Human name → security_id resolver
    │   ├── validate_order.py             # Pre-flight order validation with guardrails
    │   └── trade_logger.py               # Persistent trade journal
    │
    └── examples/
        ├── place_equity_order.py         # Simple equity delivery order
        ├── place_fno_order.py            # F&O option order with lot-size validation
        ├── fetch_option_chain.py         # Nifty option chain with ATM analysis
        ├── iron_condor.py                # Multi-leg strategy: build + analyze + place
        ├── super_order_with_sl.py        # Entry + target + trailing SL in one order
        ├── gtt_forever_order.py          # GTT single trigger and OCO orders
        ├── order_management.py           # Full lifecycle: place, modify, cancel, book
        ├── portfolio_summary.py          # Holdings + positions + funds dashboard
        ├── margin_check.py               # Pre-order margin validation
        ├── historical_data_analysis.py   # Fetch OHLCV + moving averages + stats
        └── live_feed_setup.py            # WebSocket market data streaming
```

---

## How It Works

The skill follows **progressive disclosure** to minimize context usage:

1. **SKILL.md** (~300 lines) gives the agent setup, safety rules, constants, and core code patterns — enough for 80% of tasks.
2. **references/*.md** are loaded only when a task needs deeper detail (e.g., full order parameter tables, WebSocket setup).
3. **scripts/** provide reusable utilities the agent can call directly.
4. **examples/** are complete, runnable scripts the agent can reference or adapt.

---

## When Agents Use This Skill

The skill activates when the user:

- Wants to **place, modify, or cancel** stock or F&O orders
- Asks about **portfolio holdings or positions**
- Needs **live or historical market data** (OHLC, quotes, depth)
- Wants to work with **option chains** (Greeks, OI, IV)
- Asks about **fund limits or margin requirements**
- Mentions **DhanHQ**, **Dhan API**, or Indian stock market trading
- Wants to **build trading automation** for NSE/BSE/MCX
- Needs to **backtest a strategy** using historical data

---

## Built-In Safety Guardrails

| Rule | What it does |
|------|-------------|
| **Confirmation required** | Always shows order preview and asks for user confirmation before placing |
| **Default to LIMIT** | Never places MARKET orders unless user explicitly requests |
| **Default to 1 lot** | Defaults to 1 share (equity) or 1 lot (F&O) when quantity is unspecified |
| **Lot size validation** | Rejects F&O orders where quantity isn't a lot-size multiple |
| **Product type guardrails** | Blocks CNC/MTF for F&O segments; blocks invalid product-segment combos |
| **Notional value warning** | Warns when order value exceeds ₹50,000 |
| **Freeze quantity check** | Warns when F&O quantity exceeds exchange freeze limits |
| **Market hours check** | Warns when market is closed, suggests AMO |
| **No hardcoded tokens** | Always uses environment variables for credentials |

---

## API Coverage

| Category | Reference |
|----------|-----------|
| Orders (regular, super, forever/GTT, AMO, slice) | [references/orders.md](skills/dhanhq/references/orders.md) |
| Portfolio (holdings, positions, convert, eDIS) | [references/portfolio.md](skills/dhanhq/references/portfolio.md) |
| Market Data (historical OHLC, quotes, depth) | [references/market-data.md](skills/dhanhq/references/market-data.md) |
| Option Chain (Greeks, OI, expiry list) | [references/option-chain.md](skills/dhanhq/references/option-chain.md) |
| Instruments (security master, symbol resolution) | [references/instruments.md](skills/dhanhq/references/instruments.md) |
| Funds & Margin | [references/funds.md](skills/dhanhq/references/funds.md) |
| Live Feed (MarketFeed, OrderUpdate, FullDepth) | [references/live-feed.md](skills/dhanhq/references/live-feed.md) |
| ScanX real-time scanner | [references/scanx-data.md](skills/dhanhq/references/scanx-data.md) |
| Error codes, rate limits, retry patterns | [references/error-codes.md](skills/dhanhq/references/error-codes.md) |

---

## Example Prompts

**Orders**
- "Buy 10 shares of Reliance at market"
- "Place a limit order for HDFC Bank at 1650"
- "Buy 1 lot of Nifty 24000 CE expiry this week"
- "Place a super order on TCS with target 4200 and SL 3900"
- "Set a GTT to buy Infosys if it drops to 1400"

**Portfolio**
- "Show me my holdings"
- "What's my total portfolio value?"
- "Show my open F&O positions"
- "Convert my INFY position from intraday to delivery"

**Market Data**
- "Get daily OHLC for Reliance for the last 6 months"
- "What's the current LTP of HDFC Bank?"
- "Show me 5-minute candles for TCS today"

**Options**
- "Show me the Nifty option chain for nearest expiry"
- "What's the PCR for Bank Nifty?"
- "Build me a Nifty iron condor"

**Funds & Margin**
- "What's my available margin?"
- "How much margin do I need to sell 1 lot of Nifty?"

---

## SDK Reference

- **Package**: `dhanhq` ([PyPI](https://pypi.org/project/dhanhq/))
- **Version**: 2.2.0+
- **Base URL**: `https://api.dhan.co/v2`
- **Docs**: [dhanhq.co/docs/v2](https://dhanhq.co/docs/v2/)
- **GitHub**: [github.com/dhan-oss/DhanHQ-py](https://github.com/dhan-oss/DhanHQ-py)

---

## Contributing

This skill is built for the [Agent Skills](https://agentskills.io) open standard. To contribute:

1. Fork this repository
2. Make changes in `skills/dhanhq/`
3. Verify against the DhanHQ SDK (`pip install dhanhq`)
4. Submit a pull request

---

## License

MIT
