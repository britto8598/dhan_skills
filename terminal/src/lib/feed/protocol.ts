/**
 * Wire protocol between the terminal and any market-data backend: the built-in
 * simulator (browser worker or the Node mock server at /feed) or a real Dhan /
 * Zerodha backend implementing the same messages (see terminal/README.md).
 *
 * Volumes are in shares/contracts (qty). The UI converts to lots with lotSize.
 */
import type { Instrument } from "../sim/instruments";

/** One-minute bar. `cells` is a flat [price, bidVol, askVol, price, bidVol, askVol, ...] list sorted by price. */
export interface Bar {
  t: number; // bar start, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  d: number; // delta = aggressive buy - aggressive sell
  dmin: number; // min running delta inside the bar
  dmax: number;
  n: number; // number of prints (activity)
  oi?: number;
  cells: number[];
}

/** [strike, ceBuy, ceSell, peBuy, peSell, cePremium, pePremium]; flows in lots of aggressive volume. */
export type FlowRow = [number, number, number, number, number, number, number];

export interface MinuteFlow {
  t: number;
  spot: number;
  rows: FlowRow[];
}

export interface Quote {
  s: string;
  ltp: number;
  o: number;
  h: number;
  l: number;
  pc: number; // previous close
  v: number;
  oi?: number;
  oiChg?: number;
  bv: number; // last closed 1m bar volume
  bd: number; // last closed 1m bar delta
  avgBv: number; // avg of last 20 closed 1m bar volumes
  imb: number; // stacked-imbalance score of last closed bar (+ buy / - sell)
}

export interface ChainSide {
  ltp: number;
  chg: number;
  iv: number;
  vol: number; // qty traded today
  oi: number; // qty
  oiChg: number;
  bid: number;
  ask: number;
  delta: number;
}

export interface ChainRow {
  k: number;
  ce: ChainSide;
  pe: ChainSide;
}

export interface Chain {
  root: string;
  expiry: string;
  spot: number;
  fut: number;
  atmIv: number;
  t: number;
  rows: ChainRow[];
}

/** [price, qty, orders, ...orderSizes (L3/L4 only, first 12)] */
export type DepthLevel = number[];

export interface DepthEvent {
  type: "pull" | "stack" | "iceberg";
  price: number;
  qty: number;
  side: "bid" | "ask";
}

export interface Depth {
  s: string;
  t: number;
  ltp: number;
  bids: DepthLevel[]; // best first
  asks: DepthLevel[];
  traded: [number, number, number][]; // [price, buyQty, sellQty] since last update
  events: DepthEvent[];
}

export type Sub =
  | { kind: "bars"; symbol: string; days: number }
  | { kind: "depth"; symbol: string; levels: number }
  | { kind: "chain"; root: string; expiry: string }
  | { kind: "mflow"; root: string; days: number };

export type ClientMsg =
  | { op: "hello"; speed?: number }
  | { op: "sub"; key: string; sub: Sub }
  | { op: "unsub"; key: string }
  | { op: "ping"; ts: number };

export type ServerMsg =
  | { t: "hello"; source: "mock" | "dhan" | "zerodha"; instruments: Instrument[]; simTime: number; speed: number }
  | { t: "clock"; simTime: number; speed: number }
  | { t: "hist"; key: string; symbol: string; bars: Bar[] }
  | { t: "bars"; u: [string, Bar][] }
  | { t: "quotes"; q: Quote[] }
  | { t: "depth"; key: string; d: Depth }
  | { t: "chain"; key: string; c: Chain }
  | { t: "mflow_hist"; key: string; root: string; flows: MinuteFlow[] }
  | { t: "mflow"; root: string; flows: MinuteFlow[] }
  | { t: "pong"; ts: number }
  | { t: "error"; message: string };

export function subKey(sub: Sub): string {
  switch (sub.kind) {
    case "bars":
      return `bars:${sub.symbol}:${sub.days}`;
    case "depth":
      return `depth:${sub.symbol}:${sub.levels}`;
    case "chain":
      return `chain:${sub.root}:${sub.expiry}`;
    case "mflow":
      return `mflow:${sub.root}:${sub.days}`;
  }
}
