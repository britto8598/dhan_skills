/**
 * Mock instrument master. Lot sizes, tick sizes and prices here are illustrative
 * only. With a real broker feed, the backend sends its own instrument list in the
 * `hello` message (from the Dhan security master / Kite instrument dump).
 */
import { DAY_MS, istDow, istMidnight, yymmdd, parseYymmdd, sessionClose } from "./time";

export type Kind = "INDEX" | "FUT" | "EQ" | "OPT";

export interface Instrument {
  symbol: string;
  name: string;
  kind: Kind;
  exchange: string;
  group: string;
  tickSize: number;
  lotSize: number;
  /** Price granularity of stored footprint cells. Manual tick modes must be multiples of this. */
  fpRow: number;
  /** Option root for indices/futures/options, e.g. NIFTY. */
  root?: string;
  /** FUT symbol an INDEX is derived from. */
  derivedFrom?: string;
  strike?: number;
  optType?: "CE" | "PE";
  expiry?: string; // YYMMDD
  // simulator parameters
  basePrice?: number;
  dailyVol?: number; // fraction, e.g. 0.009
  beta?: number;
  lotsPerMin?: number; // average aggressive volume per minute, in lots
}

export interface OptionRoot {
  root: string;
  fut: string;
  index: string;
  strikeStep: number;
  lotSize: number;
  weekly: boolean;
  expiryDow: number; // 2 = Tuesday, 4 = Thursday
  baseIv: number;
  flowLots: number; // typical per-strike flow per minute near ATM, in lots
}

export const OPTION_ROOTS: OptionRoot[] = [
  { root: "NIFTY", fut: "NIFTY-FUT", index: "NIFTY", strikeStep: 50, lotSize: 75, weekly: true, expiryDow: 2, baseIv: 0.12, flowLots: 140 },
  { root: "BANKNIFTY", fut: "BANKNIFTY-FUT", index: "BANKNIFTY", strikeStep: 100, lotSize: 35, weekly: false, expiryDow: 2, baseIv: 0.14, flowLots: 90 },
  { root: "FINNIFTY", fut: "FINNIFTY-FUT", index: "FINNIFTY", strikeStep: 50, lotSize: 65, weekly: false, expiryDow: 2, baseIv: 0.13, flowLots: 40 },
  { root: "SENSEX", fut: "SENSEX-FUT", index: "SENSEX", strikeStep: 100, lotSize: 20, weekly: true, expiryDow: 4, baseIv: 0.125, flowLots: 110 },
];

const FUTS: Instrument[] = [
  { symbol: "NIFTY-FUT", name: "NIFTY Futures", kind: "FUT", exchange: "NFO", group: "Index Futures", tickSize: 0.05, lotSize: 75, fpRow: 0.5, root: "NIFTY", basePrice: 25180, dailyVol: 0.0085, beta: 1, lotsPerMin: 900 },
  { symbol: "BANKNIFTY-FUT", name: "BANKNIFTY Futures", kind: "FUT", exchange: "NFO", group: "Index Futures", tickSize: 0.05, lotSize: 35, fpRow: 1, root: "BANKNIFTY", basePrice: 55640, dailyVol: 0.0105, beta: 1.15, lotsPerMin: 700 },
  { symbol: "FINNIFTY-FUT", name: "FINNIFTY Futures", kind: "FUT", exchange: "NFO", group: "Index Futures", tickSize: 0.05, lotSize: 65, fpRow: 0.5, root: "FINNIFTY", basePrice: 26540, dailyVol: 0.0095, beta: 1.05, lotsPerMin: 120 },
  { symbol: "SENSEX-FUT", name: "SENSEX Futures", kind: "FUT", exchange: "BFO", group: "Index Futures", tickSize: 0.05, lotSize: 20, fpRow: 2, root: "SENSEX", basePrice: 82450, dailyVol: 0.0082, beta: 0.98, lotsPerMin: 260 },
];

const INDICES: Instrument[] = [
  { symbol: "NIFTY", name: "NIFTY 50", kind: "INDEX", exchange: "NSE", group: "Indices", tickSize: 0.05, lotSize: 75, fpRow: 0.5, root: "NIFTY", derivedFrom: "NIFTY-FUT" },
  { symbol: "BANKNIFTY", name: "NIFTY BANK", kind: "INDEX", exchange: "NSE", group: "Indices", tickSize: 0.05, lotSize: 35, fpRow: 1, root: "BANKNIFTY", derivedFrom: "BANKNIFTY-FUT" },
  { symbol: "FINNIFTY", name: "NIFTY FIN SERVICE", kind: "INDEX", exchange: "NSE", group: "Indices", tickSize: 0.05, lotSize: 65, fpRow: 0.5, root: "FINNIFTY", derivedFrom: "FINNIFTY-FUT" },
  { symbol: "SENSEX", name: "S&P BSE SENSEX", kind: "INDEX", exchange: "BSE", group: "Indices", tickSize: 0.05, lotSize: 20, fpRow: 2, root: "SENSEX", derivedFrom: "SENSEX-FUT" },
  { symbol: "INDIAVIX", name: "INDIA VIX", kind: "INDEX", exchange: "NSE", group: "Indices", tickSize: 0.0025, lotSize: 1, fpRow: 0.01, root: "NIFTY" },
];

type StockSeed = [symbol: string, name: string, group: string, price: number, lot: number, vol: number, beta: number, lotsPerMin: number];
const STOCK_SEEDS: StockSeed[] = [
  ["RELIANCE", "Reliance Industries", "Energy", 1382, 500, 0.012, 0.9, 60],
  ["HDFCBANK", "HDFC Bank", "Banking", 962, 550, 0.011, 1.05, 70],
  ["ICICIBANK", "ICICI Bank", "Banking", 1402, 700, 0.012, 1.1, 55],
  ["SBIN", "State Bank of India", "Banking", 818, 750, 0.014, 1.2, 65],
  ["AXISBANK", "Axis Bank", "Banking", 1148, 625, 0.014, 1.15, 45],
  ["KOTAKBANK", "Kotak Mahindra Bank", "Banking", 2004, 400, 0.012, 1.0, 30],
  ["INFY", "Infosys", "IT", 1512, 400, 0.013, 0.8, 50],
  ["TCS", "Tata Consultancy", "IT", 3055, 175, 0.012, 0.75, 35],
  ["HCLTECH", "HCL Technologies", "IT", 1480, 350, 0.013, 0.8, 25],
  ["LT", "Larsen & Toubro", "Capital Goods", 3610, 175, 0.012, 1.05, 25],
  ["ITC", "ITC", "FMCG", 408, 1600, 0.01, 0.6, 50],
  ["HINDUNILVR", "Hindustan Unilever", "FMCG", 2512, 300, 0.01, 0.55, 20],
  ["BHARTIARTL", "Bharti Airtel", "Telecom", 1902, 475, 0.012, 0.8, 35],
  ["MARUTI", "Maruti Suzuki", "Auto", 12480, 50, 0.013, 0.9, 12],
  ["M&M", "Mahindra & Mahindra", "Auto", 3240, 200, 0.015, 1.05, 30],
  ["SUNPHARMA", "Sun Pharma", "Pharma", 1652, 350, 0.012, 0.6, 25],
];

const STOCKS: Instrument[] = STOCK_SEEDS.map(([symbol, name, group, price, lot, vol, beta, lpm]) => ({
  symbol,
  name,
  kind: "EQ" as const,
  exchange: "NSE",
  group,
  tickSize: price > 5000 ? 0.5 : 0.1,
  lotSize: lot,
  fpRow: price > 5000 ? 0.5 : price > 2000 ? 0.2 : 0.1,
  basePrice: price,
  dailyVol: vol,
  beta,
  lotsPerMin: lpm,
}));

export const BASE_INSTRUMENTS: Instrument[] = [...INDICES, ...FUTS, ...STOCKS];

/** Symbols the simulator evolves directly (everything else is derived). */
export const SIM_ROOTS = [...FUTS, ...STOCKS].map((i) => i.symbol);

const BY_SYMBOL = new Map(BASE_INSTRUMENTS.map((i) => [i.symbol, i]));

export function optionRoot(root: string): OptionRoot | undefined {
  return OPTION_ROOTS.find((r) => r.root === root);
}

/** NIFTY:260929:25000:CE */
export function optionSymbol(root: string, expiry: string, strike: number, type: "CE" | "PE"): string {
  return `${root}:${expiry}:${strike}:${type}`;
}

export function parseOption(symbol: string): { root: string; expiry: string; strike: number; type: "CE" | "PE" } | null {
  const p = symbol.split(":");
  if (p.length !== 4 || (p[3] !== "CE" && p[3] !== "PE")) return null;
  const strike = Number(p[2]);
  if (!Number.isFinite(strike) || !/^\d{6}$/.test(p[1])) return null;
  return { root: p[0], expiry: p[1], strike, type: p[3] };
}

export function getInstrument(symbol: string): Instrument | undefined {
  const base = BY_SYMBOL.get(symbol);
  if (base) return base;
  const o = parseOption(symbol);
  if (!o) return undefined;
  const r = optionRoot(o.root);
  if (!r) return undefined;
  return {
    symbol,
    name: `${o.root} ${o.expiry} ${o.strike} ${o.type}`,
    kind: "OPT",
    exchange: r.root === "SENSEX" ? "BFO" : "NFO",
    group: "Options",
    tickSize: 0.05,
    lotSize: r.lotSize,
    fpRow: 0.5,
    root: o.root,
    strike: o.strike,
    optType: o.type,
    expiry: o.expiry,
  };
}

/** NIFTY-FUT → NIFTY, NIFTY:...:CE → NIFTY, RELIANCE → undefined. */
export function rootOf(symbol: string): string | undefined {
  return getInstrument(symbol)?.root;
}

export function displayName(symbol: string): string {
  const o = parseOption(symbol);
  if (!o) return symbol;
  const ms = parseYymmdd(o.expiry);
  const d = ms ? new Date(ms + 19_800_000) : null;
  const mon = d ? d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }) : "";
  return `${o.root} ${d ? d.getUTCDate() : ""}${mon} ${o.strike} ${o.type}`;
}

function lastDowOfMonth(ms: number, dow: number): number {
  const d = new Date(ms + 19_800_000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  let day = Date.UTC(y, m + 1, 0) - 19_800_000; // last day of month, IST midnight
  while (istDow(day + 12 * 3600_000) !== dow) day -= DAY_MS;
  return day;
}

/** Next expiries (YYMMDD) at or after `nowMs` (an expiry stays current until 15:30 on the day). */
export function expiriesFor(root: string, nowMs: number, count = 3): string[] {
  const r = optionRoot(root);
  if (!r) return [];
  const out: number[] = [];
  const today = istMidnight(nowMs);
  const alive = (day: number) => sessionClose(day) > nowMs;
  if (r.weekly) {
    let d = today;
    while (out.length < count) {
      if (istDow(d + 12 * 3600_000) === r.expiryDow && alive(d)) out.push(d);
      d += DAY_MS;
    }
  } else {
    let probe = today;
    while (out.length < count) {
      const e = lastDowOfMonth(probe, r.expiryDow);
      if (alive(e) && !out.includes(e)) out.push(e);
      const d = new Date(probe + 19_800_000);
      probe = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 19_800_000;
    }
  }
  return out.map(yymmdd);
}

export function expiryCloseMs(expiry: string): number {
  const d = parseYymmdd(expiry);
  return d === null ? 0 : sessionClose(d);
}

export function atmStrike(root: string, spot: number): number {
  const step = optionRoot(root)?.strikeStep ?? 50;
  return Math.round(spot / step) * step;
}

export function roundTick(p: number, tick: number): number {
  return Math.round(Math.round(p / tick) * tick * 1e6) / 1e6;
}

export function searchInstruments(q: string, nowMs: number, limit = 30): Instrument[] {
  const query = q.trim().toUpperCase();
  const out: Instrument[] = BASE_INSTRUMENTS.filter(
    (i) => !query || i.symbol.includes(query) || i.name.toUpperCase().includes(query),
  );
  // "NIFTY 25000 CE" style option search
  const m = query.match(/^([A-Z]+)\s+(\d{3,6})\s*(CE|PE)?$/);
  if (m && optionRoot(m[1])) {
    const exp = expiriesFor(m[1], nowMs, 1)[0];
    const types: ("CE" | "PE")[] = m[3] ? [m[3] as "CE" | "PE"] : ["CE", "PE"];
    for (const t of types) {
      const inst = getInstrument(optionSymbol(m[1], exp, Number(m[2]), t));
      if (inst) out.unshift(inst);
    }
  }
  return out.slice(0, limit);
}
