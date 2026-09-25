/**
 * Mock NSE/BSE market simulator.
 *
 * - FUT and EQ roots evolve as correlated random walks with an intraday U-shaped
 *   volatility / volume curve and random trend days.
 * - Every print is classified buy/sell so bars carry real footprint cells.
 * - Indices are derived from their future minus a basis; INDIA VIX from NIFTY IV.
 * - Options are priced with Black-Scholes from the index; their volume comes from
 *   a deterministic per-minute options-flow model (with "institutional" bursts).
 * - History is generated backwards from the live start price, so it always joins
 *   the live series without a gap.
 */
import type { Bar, Chain, ChainRow, FlowRow, MinuteFlow, Quote } from "../feed/protocol";
import {
  BASE_INSTRUMENTS,
  SIM_ROOTS,
  OPTION_ROOTS,
  type Instrument,
  type OptionRoot,
  atmStrike,
  expiriesFor,
  expiryCloseMs,
  getInstrument,
  optionRoot,
  parseOption,
  roundTick,
} from "./instruments";
import { bsDelta, bsPrice, premiumTick, smileIv, yearsTo } from "./options";
import { expo, gauss, hash32, mulberry32, type Rng } from "./rng";
import {
  MIN_MS,
  SESSION_MINUTES,
  SESSION_OPEN_MIN,
  istMidnight,
  istMinuteOfDay,
  isWeekday,
  nextWeekdayMidnight,
  prevWeekdayMidnight,
  sessionClose,
  sessionOpen,
} from "./time";

const HIST_STEPS = 40; // micro-steps per historical minute

export class BarBuilder {
  o: number;
  h: number;
  l: number;
  c: number;
  v = 0;
  d = 0;
  dmin = 0;
  dmax = 0;
  n = 0;
  oi?: number;
  cells = new Map<number, [number, number]>();

  constructor(public t: number, public row: number, open: number) {
    this.o = this.h = this.l = this.c = open;
  }

  trade(price: number, qty: number, side: 1 | -1): void {
    if (qty <= 0) return;
    if (price > this.h) this.h = price;
    if (price < this.l) this.l = price;
    this.c = price;
    this.v += qty;
    this.d += side * qty;
    if (this.d < this.dmin) this.dmin = this.d;
    if (this.d > this.dmax) this.dmax = this.d;
    this.n++;
    const key = Math.round(Math.floor(price / this.row + 1e-9) * this.row * 1e6) / 1e6;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, (cell = [0, 0]));
    cell[side > 0 ? 1 : 0] += qty;
  }

  toBar(): Bar {
    const keys = [...this.cells.keys()].sort((a, b) => a - b);
    const cells: number[] = [];
    for (const k of keys) {
      const c = this.cells.get(k)!;
      cells.push(k, c[0], c[1]);
    }
    return { t: this.t, o: this.o, h: this.h, l: this.l, c: this.c, v: this.v, d: this.d, dmin: this.dmin, dmax: this.dmax, n: this.n, oi: this.oi, cells };
  }
}

interface RootState {
  inst: Instrument;
  fair: number;
  last: number;
  lastSide: 1 | -1;
  rng: Rng;
  cur: BarBuilder;
  bars: Bar[]; // closed live bars
  hist: Bar[]; // generated history, strictly before liveStart
  dayOpen: number;
  prevClose: number;
  dayHigh: number;
  dayLow: number;
  dayVol: number;
  dayDrift: number;
  dayVolFactor: number;
  oi: number;
  oiDayOpen: number;
  tape: [number, number, 1 | -1][];
}

interface TodayAgg {
  day: number;
  upto: number;
  agg: Map<number, [number, number, number, number]>;
}

export interface SimOptions {
  seed?: number;
  speed?: number;
  now?: number;
}

/** Session minute index 0..374 for a timestamp inside the session. */
function sessionMinute(t: number): number {
  return Math.min(Math.max(istMinuteOfDay(t) - SESSION_OPEN_MIN, 0), SESSION_MINUTES - 1);
}

function volumeCurve(t: number): number {
  const m = sessionMinute(t);
  return 0.65 + 1.2 * Math.exp(-m / 30) + 0.6 * Math.exp(-(SESSION_MINUTES - m) / 35);
}

function volatilityCurve(t: number): number {
  const m = sessionMinute(t);
  return 0.72 + 0.95 * Math.exp(-m / 40) + 0.35 * Math.exp(-(SESSION_MINUTES - m) / 40);
}

function pickStart(now: number): number {
  const mod = istMinuteOfDay(now);
  if (isWeekday(now) && mod >= SESSION_OPEN_MIN + 20 && mod < SESSION_OPEN_MIN + SESSION_MINUTES - 1) {
    return Math.floor(now / MIN_MS) * MIN_MS;
  }
  const day = isWeekday(now) && mod >= SESSION_OPEN_MIN + 20 ? istMidnight(now) : prevWeekdayMidnight(now);
  return day + 12 * 60 * MIN_MS; // replay from 12:00 when the real market is closed
}

export class MarketSim {
  simTime: number;
  speed: number;
  readonly liveStart: number;
  readonly seed: number;
  private roots = new Map<string, RootState>();
  private flowCache = new Map<string, MinuteFlow>();
  private todayAggs = new Map<string, TodayAgg>();

  constructor(opts: SimOptions = {}) {
    this.seed = opts.seed ?? 20260925;
    this.speed = opts.speed ?? 1;
    this.liveStart = pickStart(opts.now ?? Date.now());
    this.simTime = this.liveStart;
    const market = mulberry32(hash32("start", this.seed));
    for (const sym of SIM_ROOTS) {
      const inst = BASE_INSTRUMENTS.find((i) => i.symbol === sym)!;
      const p0 = roundTick(inst.basePrice! * (1 + (market() - 0.5) * 0.01), inst.tickSize);
      const st: RootState = {
        inst,
        fair: p0,
        last: p0,
        lastSide: 1,
        rng: mulberry32(hash32(sym, this.seed)),
        cur: new BarBuilder(this.liveStart, inst.fpRow, p0),
        bars: [],
        hist: [],
        dayOpen: p0,
        prevClose: p0,
        dayHigh: p0,
        dayLow: p0,
        dayVol: 0,
        dayDrift: 0,
        dayVolFactor: 1,
        oi: inst.kind === "FUT" ? Math.round((inst.lotsPerMin! * 180 * inst.lotSize) / 10) * 10 : 0,
        oiDayOpen: 0,
        tape: [],
      };
      this.roots.set(sym, st);
      this.ensureHistory(st, 2);
      this.initDayStats(st);
    }
  }

  // ------------------------------------------------------------------ history

  private dayParams(sym: string, day: number): { drift: number; volf: number } {
    const r = mulberry32(hash32("day" + sym, day, this.seed));
    const volf = 0.7 + r() * 0.6;
    const drift = gauss(r) * 0.02;
    return { drift, volf };
  }

  private sigmaMin(inst: Instrument, t: number, volf: number): number {
    return ((inst.basePrice! * inst.dailyVol!) / Math.sqrt(SESSION_MINUTES)) * volatilityCurve(t) * volf;
  }

  /** Earliest session-open timestamp needed to cover `days` sessions ending today. */
  sessionsFrom(days: number): number {
    let day = istMidnight(this.simTime);
    for (let i = 1; i < days; i++) day = prevWeekdayMidnight(day);
    return day + SESSION_OPEN_MIN * MIN_MS;
  }

  private ensureHistory(st: RootState, days: number): void {
    const from = this.sessionsFrom(days);
    const inst = st.inst;
    let nextOpen = st.hist.length ? st.hist[0].o : st.fair;
    let t = st.hist.length ? st.hist[0].t - MIN_MS : this.liveStart - MIN_MS;
    const out: Bar[] = [];
    while (true) {
      // hop over the overnight gap
      if (t < sessionOpen(t) || !isWeekday(t)) {
        const prevDay = prevWeekdayMidnight(t + MIN_MS);
        const close = sessionClose(prevDay);
        const gapR = mulberry32(hash32("gap" + inst.symbol, prevDay, this.seed));
        nextOpen = nextOpen / (1 + gauss(gapR) * 0.0035);
        t = close - MIN_MS;
      } else if (t >= sessionClose(t)) {
        t = sessionClose(t) - MIN_MS;
      }
      if (t < from) break;
      const day = istMidnight(t);
      const { drift, volf } = this.dayParams(inst.symbol, day);
      const rng = mulberry32(hash32("h" + inst.symbol, t, this.seed));
      const bar = this.genMinute(inst, t, nextOpen, rng, drift, volf);
      out.push(bar);
      nextOpen = bar.o;
      t -= MIN_MS;
    }
    if (out.length) {
      out.reverse();
      st.hist = out.concat(st.hist);
      if (inst.kind === "FUT") {
        // rough OI path for history: drifts toward the live OI
        let oi = st.oi;
        for (let i = st.hist.length - 1; i >= 0; i--) {
          st.hist[i].oi = oi;
          oi = Math.max(0, oi - st.hist[i].d * 0.08);
        }
      }
    }
  }

  /** One historical minute whose close equals `close`. */
  private genMinute(inst: Instrument, t: number, close: number, rng: Rng, drift: number, volf: number): Bar {
    const sig = this.sigmaMin(inst, t, volf);
    const stepSig = sig / Math.sqrt(HIST_STEPS);
    const x: number[] = [0];
    for (let i = 1; i <= HIST_STEPS; i++) x.push(x[i - 1] + stepSig * gauss(rng) + (drift * sig) / HIST_STEPS);
    const open = close - x[HIST_STEPS];
    const b = new BarBuilder(t, inst.fpRow, roundTick(open, inst.tickSize));
    const meanLots = ((inst.lotsPerMin! * volumeCurve(t) * volf) / HIST_STEPS) * 1.0;
    for (let i = 1; i <= HIST_STEPS; i++) {
      const dp = x[i] - x[i - 1];
      const price = i === HIST_STEPS ? roundTick(close, inst.tickSize) : roundTick(open + x[i], inst.tickSize);
      this.printAt(b, inst, price, dp / stepSig, meanLots * (1 + 0.6 * Math.abs(dp / stepSig)), rng);
    }
    b.c = roundTick(close, inst.tickSize);
    b.h = Math.max(b.h, b.c);
    b.l = Math.min(b.l, b.c);
    return b.toBar();
  }

  /** Split a print into aggressive buys and sells; occasionally a large block. */
  private printAt(b: BarBuilder, inst: Instrument, price: number, z: number, meanLots: number, rng: Rng): [number, number] {
    let lots = Math.round(expo(rng, meanLots));
    if (rng() < 0.012) lots += Math.round(meanLots * (10 + rng() * 30));
    if (lots <= 0) return [0, 0];
    const pBuy = Math.min(0.95, Math.max(0.05, 0.5 + 0.38 * Math.tanh(z) + (rng() - 0.5) * 0.3));
    const buyLots = Math.round(lots * pBuy);
    const buy = buyLots * inst.lotSize;
    const sell = (lots - buyLots) * inst.lotSize;
    if (z >= 0) {
      b.trade(price, sell, -1);
      b.trade(price, buy, 1);
    } else {
      b.trade(price, buy, 1);
      b.trade(price, sell, -1);
    }
    return [buy, sell];
  }

  private initDayStats(st: RootState): void {
    const today = istMidnight(this.simTime);
    const todays = st.hist.filter((b) => b.t >= today);
    const prev = st.hist.filter((b) => b.t < today);
    st.prevClose = prev.length ? prev[prev.length - 1].c : st.fair;
    st.dayOpen = todays.length ? todays[0].o : st.fair;
    st.dayHigh = Math.max(st.fair, ...todays.map((b) => b.h));
    st.dayLow = Math.min(st.fair, ...todays.map((b) => b.l));
    st.dayVol = todays.reduce((a, b) => a + b.v, 0);
    st.oiDayOpen = todays.length && todays[0].oi !== undefined ? todays[0].oi : st.oi;
    const p = this.dayParams(st.inst.symbol, today);
    st.dayDrift = p.drift;
    st.dayVolFactor = p.volf;
  }

  // ------------------------------------------------------------------ live

  /** Advance the simulation by `realMs` of wall-clock time. */
  step(realMs: number): { dayRolled: boolean } {
    let simDt = Math.min(realMs * this.speed, 5000);
    let dayRolled = false;
    for (const st of this.roots.values()) st.tape.length = 0;
    while (simDt > 0) {
      const close = sessionClose(this.simTime);
      const chunk = Math.min(simDt, close - this.simTime);
      if (chunk > 0) this.advance(chunk);
      simDt -= Math.max(chunk, 0);
      if (this.simTime >= close) {
        this.rollDay();
        dayRolled = true;
        simDt = 0;
      }
    }
    return { dayRolled };
  }

  private advance(dt: number): void {
    const k = Math.max(1, Math.min(20, Math.round(dt / 250)));
    const sub = dt / k;
    for (let i = 0; i < k; i++) {
      this.simTime += sub;
      const minute = Math.floor(this.simTime / MIN_MS) * MIN_MS;
      const shock = gauss(Math.random);
      for (const st of this.roots.values()) {
        if (minute > st.cur.t) this.closeBar(st, minute);
        this.evolve(st, sub / 1000, shock);
      }
    }
  }

  private closeBar(st: RootState, newT: number): void {
    st.cur.oi = st.inst.kind === "FUT" ? Math.round(st.oi) : undefined;
    st.bars.push(st.cur.toBar());
    if (st.bars.length > 20000) st.bars.splice(0, st.bars.length - 20000);
    st.cur = new BarBuilder(newT, st.inst.fpRow, st.last);
  }

  private evolve(st: RootState, dtSec: number, shock: number): void {
    const inst = st.inst;
    const t = this.simTime;
    const sig = this.sigmaMin(inst, t, st.dayVolFactor) * Math.sqrt(dtSec / 60);
    const beta = Math.min(inst.beta ?? 1, 1);
    const eps = beta * 0.75 * shock + Math.sqrt(1 - 0.5625 * beta * beta) * gauss(st.rng);
    const dp = sig * eps + (st.dayDrift * this.sigmaMin(inst, t, st.dayVolFactor) * dtSec) / 60;
    st.fair += dp;
    const price = roundTick(st.fair, inst.tickSize);
    const meanLots = inst.lotsPerMin! * volumeCurve(t) * st.dayVolFactor * (dtSec / 60) * (1 + 0.6 * Math.abs(eps));
    const [buy, sell] = this.printAt(st.cur, inst, price, eps, meanLots, st.rng);
    if (buy + sell > 0) {
      st.last = price;
      st.lastSide = buy >= sell ? 1 : -1;
      st.dayVol += buy + sell;
      if (price > st.dayHigh) st.dayHigh = price;
      if (price < st.dayLow) st.dayLow = price;
      if (buy) st.tape.push([price, buy, 1]);
      if (sell) st.tape.push([price, sell, -1]);
      if (inst.kind === "FUT") st.oi = Math.max(0, st.oi + (st.rng() - 0.47) * (buy + sell) * 0.15);
    }
  }

  private rollDay(): void {
    const next = nextWeekdayMidnight(this.simTime) + SESSION_OPEN_MIN * MIN_MS;
    for (const st of this.roots.values()) {
      this.closeBar(st, next);
      st.prevClose = st.last;
      st.fair = st.fair * (1 + gauss(st.rng) * 0.0035);
      st.last = roundTick(st.fair, st.inst.tickSize);
      st.cur = new BarBuilder(next, st.inst.fpRow, st.last);
      st.dayOpen = st.dayHigh = st.dayLow = st.last;
      st.dayVol = 0;
      st.oiDayOpen = st.oi;
      const p = this.dayParams(st.inst.symbol, istMidnight(next));
      st.dayDrift = p.drift;
      st.dayVolFactor = p.volf;
    }
    this.simTime = next;
    this.todayAggs.clear();
  }

  // ------------------------------------------------------------------ series

  /** Raw FUT/EQ bars with t >= from (history generated as needed). */
  private rawBars(sym: string, from: number, includeCurrent = true): Bar[] {
    const st = this.roots.get(sym);
    if (!st) return [];
    const out: Bar[] = [];
    if (from < this.liveStart) {
      for (const b of st.hist) if (b.t >= from) out.push(b);
    }
    for (const b of st.bars) if (b.t >= from) out.push(b);
    if (includeCurrent && st.cur.t >= from && st.cur.n > 0) out.push(st.cur.toBar());
    return out;
  }

  /** Basis (fut - index) for a day, deterministic and rounded to the footprint row so cells stay aligned. */
  private basis(fut: Instrument, day: number): number {
    const r = optionRoot(fut.root!)!;
    const exp = expiryCloseMs(expiriesFor(r.root, day + 16 * 3600_000, 3).slice(-1)[0]);
    const dte = Math.max(1, (exp - day) / 86_400_000);
    const b = (fut.basePrice! * 0.065 * Math.min(dte, 30)) / 365;
    return Math.round(b / fut.fpRow) * fut.fpRow;
  }

  private shiftBar(b: Bar, s: number): Bar {
    const cells = b.cells.slice();
    for (let i = 0; i < cells.length; i += 3) cells[i] = Math.round((cells[i] - s) * 1e6) / 1e6;
    return { ...b, o: b.o - s, h: b.h - s, l: b.l - s, c: b.c - s, cells };
  }

  private indexBars(index: Instrument, from: number, includeCurrent = true): Bar[] {
    const fut = getInstrument(index.derivedFrom!)!;
    const raw = this.rawBars(fut.symbol, from, includeCurrent);
    const cache = new Map<number, number>();
    return raw.map((b) => {
      const day = istMidnight(b.t);
      let s = cache.get(day);
      if (s === undefined) {
        s = this.basis(fut, day);
        cache.set(day, s);
      }
      return this.shiftBar(b, s);
    });
  }

  private vixBars(from: number, includeCurrent = true): Bar[] {
    const nifty = getInstrument("NIFTY")!;
    return this.indexBars(nifty, from, includeCurrent).map((b) => {
      const iv = this.atmIv(optionRoot("NIFTY")!, b.t) * 100;
      const move = ((b.h - b.l) / b.c) * 400;
      const c = Math.round((iv + move) * 400) / 400;
      return { t: b.t, o: c, h: c + move * 0.3, l: c - move * 0.1, c, v: 0, d: 0, dmin: 0, dmax: 0, n: 0, cells: [] };
    });
  }

  atmIv(r: OptionRoot, t: number): number {
    const d = t / 86_400_000;
    const ph = (hash32(r.root) % 1000) / 159;
    const m = sessionMinute(t);
    return r.baseIv * (1 + 0.11 * Math.sin((2 * Math.PI * d) / 3.3 + ph) + 0.05 * Math.sin((2 * Math.PI * d) / 0.29 + ph * 2)) * (1 + 0.07 * Math.exp(-m / 30));
  }

  private optionBars(symbol: string, from: number, includeCurrent = true): Bar[] {
    const o = parseOption(symbol);
    const r = o && optionRoot(o.root);
    if (!o || !r) return [];
    const index = getInstrument(r.index)!;
    const expClose = expiryCloseMs(o.expiry);
    const lot = r.lotSize;
    const out: Bar[] = [];
    for (const ib of this.indexBars(index, from, includeCurrent)) {
      if (ib.t >= expClose) break;
      const T = yearsTo(expClose, ib.t + 30_000);
      const ivAtm = this.atmIv(r, ib.t);
      const f = (S: number) => premiumTick(bsPrice(S, o.strike, T, smileIv(ivAtm, S, o.strike), o.type));
      const po = f(ib.o);
      const pc = f(ib.c);
      const pa = f(ib.h);
      const pb = f(ib.l);
      const h = Math.max(po, pc, pa, pb);
      const l = Math.min(po, pc, pa, pb);
      const partial = ib.t === this.curMinute() ? (this.simTime - ib.t) / MIN_MS : 1;
      const flow = this.flowFor(r, ib, partial);
      const row = flow.rows.find((x) => x[0] === o.strike);
      const fr = mulberry32(hash32(symbol, ib.t));
      const buyLots = row ? (o.type === "CE" ? row[1] : row[3]) : Math.round(fr() * 8 * partial);
      const sellLots = row ? (o.type === "CE" ? row[2] : row[4]) : Math.round(fr() * 8 * partial);
      const buy = buyLots * lot;
      const sell = sellLots * lot;
      const cells: number[] = [];
      const rowSz = 0.5;
      const lo = Math.floor(l / rowSz) * rowSz;
      const nRows = Math.max(1, Math.min(40, Math.round((h - lo) / rowSz) + 1));
      let wsum = 0;
      const ws: number[] = [];
      for (let i = 0; i < nRows; i++) {
        const p = lo + i * rowSz;
        const w = 1 / (1 + Math.abs(p - pc) / Math.max(rowSz, (h - l) / 3)) + fr() * 0.3;
        ws.push(w);
        wsum += w;
      }
      let accB = 0;
      let accS = 0;
      for (let i = 0; i < nRows; i++) {
        const share = ws[i] / wsum;
        const bq = i === nRows - 1 ? buy - accB : Math.round((buy * share) / lot) * lot;
        const sq = i === nRows - 1 ? sell - accS : Math.round((sell * share) / lot) * lot;
        accB += bq;
        accS += sq;
        if (bq > 0 || sq > 0) cells.push(Math.round((lo + i * rowSz) * 1e6) / 1e6, Math.max(0, sq), Math.max(0, bq));
      }
      const d = buy - sell;
      out.push({ t: ib.t, o: po, h, l, c: pc, v: buy + sell, d, dmin: Math.min(0, d * 0.6), dmax: Math.max(0, d * 0.6), n: Math.round((buyLots + sellLots) / 3), cells });
    }
    return out;
  }

  private curMinute(): number {
    return Math.floor(this.simTime / MIN_MS) * MIN_MS;
  }

  /** Bars for any symbol covering `days` sessions (1 = today). */
  getHistory(symbol: string, days: number): Bar[] {
    const d = Math.max(1, Math.min(30, Math.round(days)));
    const st = this.roots.get(this.sourceOf(symbol));
    if (st) this.ensureHistory(st, d);
    return this.series(symbol, this.sessionsFrom(d));
  }

  /** The simulated FUT/EQ root a symbol's bars are derived from. */
  private sourceOf(symbol: string): string {
    const inst = getInstrument(symbol);
    if (!inst) return symbol;
    if (inst.kind === "INDEX") return inst.derivedFrom ?? "NIFTY-FUT";
    if (inst.kind === "OPT") return optionRoot(inst.root!)!.fut;
    return symbol;
  }

  /** Bars with t >= from, without generating new history (used for live updates). */
  series(symbol: string, from: number): Bar[] {
    const inst = getInstrument(symbol);
    if (!inst) return [];
    if (symbol === "INDIAVIX") return this.vixBars(from);
    if (inst.kind === "INDEX") return this.indexBars(inst, from);
    if (inst.kind === "OPT") return this.optionBars(symbol, from);
    return this.rawBars(symbol, from);
  }

  // ------------------------------------------------------------------ options flow

  /** Deterministic options flow for one index minute bar. `partial` scales an in-progress minute. */
  flowFor(r: OptionRoot, ib: Bar, partial = 1): MinuteFlow {
    const key = `${r.root}|${ib.t}`;
    if (partial >= 1) {
      const hit = this.flowCache.get(key);
      if (hit && hit.spot === ib.c) return hit;
    }
    const rng = mulberry32(hash32("flow" + r.root, ib.t, this.seed));
    const fut = getInstrument(r.fut)!;
    const sig = this.sigmaMin(fut, ib.t, 1);
    const z = Math.tanh((ib.c - ib.o) / Math.max(sig, 1e-9) / 1.5);
    const base = r.flowLots * volumeCurve(ib.t);
    const spot = ib.c;
    const atm = atmStrike(r.root, spot);
    const expiry = expiriesFor(r.root, ib.t, 1)[0];
    const T = yearsTo(expiryCloseMs(expiry), ib.t + 30_000);
    const iv = this.atmIv(r, ib.t);
    const evtRoll = rng();
    const evtDir = rng() < 0.5 + 0.35 * z ? 1 : -1;
    const evtCount = 1 + Math.floor(rng() * 5);
    const evtAt = rng();
    const evt = evtRoll < 0.03 && partial >= evtAt ? evtDir : 0;
    const scale = r.flowLots / 140;
    const rows: FlowRow[] = [];
    for (let i = -10; i <= 10; i++) {
      const K = atm + i * r.strikeStep;
      const w = Math.exp(-((i / 4.5) ** 2));
      const n = () => 0.55 + 0.9 * rng();
      let ceBuy = base * w * (1 + 0.9 * Math.max(z, 0)) * n();
      let ceSell = base * w * (1 + 0.9 * Math.max(-z, 0)) * n() * 1.05;
      let peBuy = base * w * (1 + 0.9 * Math.max(-z, 0)) * n();
      let peSell = base * w * (1 + 0.9 * Math.max(z, 0)) * n() * 1.05;
      const burst = (700 + 1900 * rng()) * scale;
      if (evt > 0 && i <= 0 && i > -evtCount) peSell += burst;
      if (evt < 0 && i >= 0 && i < evtCount) ceSell += burst;
      const f = Math.min(1, partial);
      ceBuy *= f;
      ceSell *= f;
      peBuy *= f;
      peSell *= f;
      const ceP = premiumTick(bsPrice(spot, K, T, smileIv(iv, spot, K), "CE"));
      const peP = premiumTick(bsPrice(spot, K, T, smileIv(iv, spot, K), "PE"));
      rows.push([K, Math.round(ceBuy), Math.round(ceSell), Math.round(peBuy), Math.round(peSell), ceP, peP]);
    }
    const mf: MinuteFlow = { t: ib.t, spot, rows };
    if (partial >= 1) {
      this.flowCache.set(key, mf);
      if (this.flowCache.size > 60000) this.flowCache.clear();
    }
    return mf;
  }

  getFlowHistory(root: string, days: number): MinuteFlow[] {
    const r = optionRoot(root);
    if (!r) return [];
    const d = Math.max(1, Math.min(30, Math.round(days)));
    this.ensureHistory(this.roots.get(r.fut)!, d);
    return this.flowsSince(r, this.sessionsFrom(d));
  }

  flowsSince(r: OptionRoot, from: number): MinuteFlow[] {
    const cur = this.curMinute();
    return this.indexBars(getInstrument(r.index)!, from).map((b) =>
      this.flowFor(r, b, b.t === cur ? (this.simTime - b.t) / MIN_MS : 1),
    );
  }

  private todayAgg(r: OptionRoot): Map<number, [number, number, number, number]> {
    const today = istMidnight(this.simTime);
    let a = this.todayAggs.get(r.root);
    if (!a || a.day !== today) {
      a = { day: today, upto: 0, agg: new Map() };
      this.todayAggs.set(r.root, a);
    }
    const cur = this.curMinute();
    const bars = this.indexBars(getInstrument(r.index)!, Math.max(today, a.upto + 1), false);
    for (const b of bars) {
      if (b.t >= cur) continue;
      for (const row of this.flowFor(r, b, 1).rows) {
        const x = a.agg.get(row[0]) ?? [0, 0, 0, 0];
        x[0] += row[1];
        x[1] += row[2];
        x[2] += row[3];
        x[3] += row[4];
        a.agg.set(row[0], x);
      }
      a.upto = b.t;
    }
    return a.agg;
  }

  // ------------------------------------------------------------------ chain / quotes

  spotOf(root: string): number {
    const r = optionRoot(root)!;
    const bars = this.indexBars(getInstrument(r.index)!, this.curMinute());
    const st = this.roots.get(r.fut)!;
    return bars.length ? bars[bars.length - 1].c : st.last;
  }

  getChain(root: string, expiry: string): Chain | null {
    const r = optionRoot(root);
    if (!r) return null;
    const expClose = expiryCloseMs(expiry);
    if (!expClose) return null;
    const fut = this.roots.get(r.fut)!;
    const spot = this.spotOf(root);
    const T = yearsTo(expClose, this.simTime);
    const iv = this.atmIv(r, this.simTime);
    const today = istMidnight(this.simTime);
    const prevCloseT = sessionClose(prevWeekdayMidnight(this.simTime));
    const prevSpot = spot * (fut.prevClose / fut.last);
    const Tprev = yearsTo(expClose, prevCloseT);
    const ivPrev = this.atmIv(r, prevCloseT - MIN_MS);
    const agg = this.todayAgg(r);
    const partialBars = this.indexBars(getInstrument(r.index)!, this.curMinute());
    const partial = partialBars.length ? this.flowFor(r, partialBars[partialBars.length - 1], (this.simTime - this.curMinute()) / MIN_MS) : null;
    const near = expiriesFor(root, this.simTime, 1)[0] === expiry;
    const farScale = near ? 1 : 0.3;
    const openSpot = spot * (fut.dayOpen / fut.last);
    const atmOpen = atmStrike(root, openSpot);
    const atm = atmStrike(root, spot);
    const lot = r.lotSize;
    const rows: ChainRow[] = [];
    for (let i = -15; i <= 15; i++) {
      const K = atm + i * r.strikeStep;
      const a = agg.get(K) ?? [0, 0, 0, 0];
      const p = partial?.rows.find((x) => x[0] === K);
      const cb = (a[0] + (p?.[1] ?? 0)) * farScale;
      const cs = (a[1] + (p?.[2] ?? 0)) * farScale;
      const pb = (a[2] + (p?.[3] ?? 0)) * farScale;
      const ps = (a[3] + (p?.[4] ?? 0)) * farScale;
      const noise = mulberry32(hash32("oi" + root, K, today));
      const dist = (K - atmOpen) / r.strikeStep;
      const scale = (r.flowLots / 140) * (near ? 1 : 0.35);
      const round = K % (r.strikeStep * 10) === 0 ? 1 : 0;
      const ceBase = (3000 + 52000 * Math.exp(-(((dist - 4) / 5) ** 2)) + round * 22000) * scale * (0.8 + noise() * 0.4);
      const peBase = (3000 + 52000 * Math.exp(-(((dist + 4) / 5) ** 2)) + round * 22000) * scale * (0.8 + noise() * 0.4);
      const side = (type: "CE" | "PE", buy: number, sell: number, baseLots: number): ChainRow["ce"] => {
        const siv = smileIv(iv, spot, K);
        const ltp = premiumTick(bsPrice(spot, K, T, siv, type));
        const prev = premiumTick(bsPrice(prevSpot, K, Tprev, smileIv(ivPrev, prevSpot, K), type));
        const spread = Math.max(0.05, Math.round(ltp * 0.0015 * 20) / 20);
        const oi = Math.max(0, Math.round((baseLots + (sell - buy) * 0.65) * lot));
        return {
          ltp,
          chg: Math.round((ltp - prev) * 100) / 100,
          iv: Math.round(siv * 10000) / 100,
          vol: Math.round((buy + sell + 40 * scale) * lot),
          oi,
          oiChg: Math.round(oi - baseLots * lot),
          bid: premiumTick(ltp - spread / 2),
          ask: premiumTick(ltp + spread / 2),
          delta: Math.round(bsDelta(spot, K, T, siv, type) * 1000) / 1000,
        };
      };
      rows.push({ k: K, ce: side("CE", cb, cs, ceBase), pe: side("PE", pb, ps, peBase) });
    }
    return { root, expiry, spot, fut: fut.last, atmIv: Math.round(iv * 10000) / 100, t: this.simTime, rows };
  }

  private imbalanceScore(b: Bar | undefined, ratio = 3): number {
    if (!b || b.cells.length < 6) return 0;
    let buy = 0;
    let sell = 0;
    const c = b.cells;
    for (let i = 3; i < c.length; i += 3) {
      const askHere = c[i + 2];
      const bidBelow = c[i - 2];
      if (askHere > 0 && askHere >= ratio * Math.max(bidBelow, 1)) buy++;
    }
    for (let i = 0; i < c.length - 3; i += 3) {
      const bidHere = c[i + 1];
      const askAbove = c[i + 5];
      if (bidHere > 0 && bidHere >= ratio * Math.max(askAbove, 1)) sell++;
    }
    return buy - sell;
  }

  getQuotes(): Quote[] {
    const out: Quote[] = [];
    for (const inst of BASE_INSTRUMENTS) {
      if (inst.symbol === "INDIAVIX") {
        const vb = this.vixBars(this.curMinute() - 2 * MIN_MS);
        const last = vb[vb.length - 1];
        const pc = this.atmIv(optionRoot("NIFTY")!, sessionClose(prevWeekdayMidnight(this.simTime)) - MIN_MS) * 100;
        const ltp = last ? last.c : pc;
        out.push({ s: inst.symbol, ltp, o: pc, h: Math.max(ltp, pc), l: Math.min(ltp, pc), pc, v: 0, bv: 0, bd: 0, avgBv: 0, imb: 0 });
        continue;
      }
      const src = inst.kind === "INDEX" ? inst.derivedFrom! : inst.symbol;
      const st = this.roots.get(src);
      if (!st) continue;
      const s = inst.kind === "INDEX" ? this.basis(getInstrument(src)!, istMidnight(this.simTime)) : 0;
      const closed = st.bars.length ? st.bars : st.hist;
      const lastClosed = closed[closed.length - 1];
      const recent = closed.slice(-20);
      const avgBv = recent.length ? recent.reduce((a, b) => a + b.v, 0) / recent.length : 0;
      out.push({
        s: inst.symbol,
        ltp: st.last - s,
        o: st.dayOpen - s,
        h: st.dayHigh - s,
        l: st.dayLow - s,
        pc: st.prevClose - s,
        v: st.dayVol,
        oi: inst.kind === "FUT" ? Math.round(st.oi) : undefined,
        oiChg: inst.kind === "FUT" ? Math.round(st.oi - st.oiDayOpen) : undefined,
        bv: lastClosed?.v ?? 0,
        bd: lastClosed?.d ?? 0,
        avgBv,
        imb: this.imbalanceScore(lastClosed),
      });
    }
    return out;
  }

  /** Prints since the last step for a FUT/EQ symbol (for depth books). */
  tape(symbol: string): [number, number, 1 | -1][] {
    return this.roots.get(symbol)?.tape ?? [];
  }

  lastTrade(symbol: string): { price: number; side: 1 | -1 } | null {
    const st = this.roots.get(symbol);
    return st ? { price: st.last, side: st.lastSide } : null;
  }

  static optionRoots(): OptionRoot[] {
    return OPTION_ROOTS;
  }
}
