/**
 * Runs a MarketSim and serves any number of clients over the wire protocol.
 * Used by the browser SharedWorker (Trial Mode) and by the Node mock server (/feed).
 */
import type { Bar, ClientMsg, ServerMsg, Sub } from "../feed/protocol";
import { BASE_INSTRUMENTS, getInstrument, optionRoot } from "./instruments";
import { DepthBook } from "./depth";
import { MarketSim } from "./market";
import { hash32, mulberry32 } from "./rng";
import { MIN_MS } from "./time";

interface Client {
  send: (msg: ServerMsg) => void;
  subs: Map<string, Sub>;
  lastBarT: Map<string, number>;
  lastFlowT: Map<string, number>;
}

export class SimHost {
  readonly sim: MarketSim;
  private clients = new Map<string, Client>();
  private books = new Map<string, DepthBook>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastStep = Date.now();
  private ticks = 0;
  private speedLocked = false;

  constructor(sim?: MarketSim) {
    this.sim = sim ?? new MarketSim();
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.lastStep = Date.now();
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  addClient(id: string, send: (msg: ServerMsg) => void): void {
    this.clients.set(id, { send, subs: new Map(), lastBarT: new Map(), lastFlowT: new Map() });
  }

  removeClient(id: string): void {
    this.clients.delete(id);
    this.gcBooks();
  }

  handle(id: string, msg: ClientMsg): void {
    const c = this.clients.get(id);
    if (!c) return;
    try {
      switch (msg.op) {
        case "hello":
          if (msg.speed && !this.speedLocked) {
            this.sim.speed = Math.max(0.25, Math.min(60, msg.speed));
            this.speedLocked = true;
          }
          c.send({ t: "hello", source: "mock", instruments: BASE_INSTRUMENTS, simTime: this.sim.simTime, speed: this.sim.speed });
          c.send({ t: "quotes", q: this.sim.getQuotes() });
          break;
        case "ping":
          c.send({ t: "pong", ts: msg.ts });
          break;
        case "sub":
          c.subs.set(msg.key, msg.sub);
          this.onSub(c, msg.key, msg.sub);
          break;
        case "unsub":
          c.subs.delete(msg.key);
          this.gcBooks();
          break;
      }
    } catch (e) {
      c.send({ t: "error", message: String((e as Error)?.message ?? e) });
    }
  }

  private onSub(c: Client, key: string, sub: Sub): void {
    if (sub.kind === "bars") {
      const bars = this.sim.getHistory(sub.symbol, sub.days);
      c.send({ t: "hist", key, symbol: sub.symbol, bars });
      c.lastBarT.set(sub.symbol, bars.length ? bars[bars.length - 1].t : this.sim.simTime);
    } else if (sub.kind === "chain") {
      const ch = this.sim.getChain(sub.root, sub.expiry);
      if (ch) c.send({ t: "chain", key, c: ch });
    } else if (sub.kind === "mflow") {
      const flows = this.sim.getFlowHistory(sub.root, sub.days);
      c.send({ t: "mflow_hist", key, root: sub.root, flows });
      c.lastFlowT.set(sub.root, flows.length ? flows[flows.length - 1].t : this.sim.simTime);
    } else if (sub.kind === "depth") {
      this.book(sub.symbol);
    }
  }

  private book(symbol: string): DepthBook | null {
    let b = this.books.get(symbol);
    if (b) return b;
    const inst = getInstrument(symbol);
    if (!inst || inst.kind === "INDEX") return null;
    const meanLots = inst.kind === "OPT" ? 6 : Math.max(2, Math.round((inst.lotsPerMin ?? 100) / 120));
    b = new DepthBook(symbol, inst.tickSize, inst.lotSize, mulberry32(hash32("book" + symbol)), meanLots);
    this.books.set(symbol, b);
    return b;
  }

  private gcBooks(): void {
    const used = new Set<string>();
    for (const c of this.clients.values()) for (const s of c.subs.values()) if (s.kind === "depth") used.add(s.symbol);
    for (const k of [...this.books.keys()]) if (!used.has(k)) this.books.delete(k);
  }

  private tick(): void {
    const now = Date.now();
    const dt = now - this.lastStep;
    this.lastStep = now;
    this.sim.step(dt);
    this.ticks++;
    const seriesCache = new Map<string, Bar[]>();
    const depthCache = new Map<string, ReturnType<DepthBook["update"]>>();
    const curMinute = Math.floor(this.sim.simTime / MIN_MS) * MIN_MS;

    // depth books advance once per tick, shared by all clients
    const depthLevels = new Map<string, number>();
    for (const c of this.clients.values())
      for (const s of c.subs.values())
        if (s.kind === "depth") depthLevels.set(s.symbol, Math.max(depthLevels.get(s.symbol) ?? 0, s.levels));
    for (const [sym, levels] of depthLevels) {
      const b = this.book(sym);
      if (!b) continue;
      const inst = getInstrument(sym)!;
      let lt = this.sim.lastTrade(sym);
      let tape = this.sim.tape(sym);
      if (!lt) {
        const ser = this.sim.series(sym, curMinute - MIN_MS);
        const last = ser[ser.length - 1];
        if (!last) continue;
        lt = { price: last.c, side: last.d >= 0 ? 1 : -1 };
        tape = [[last.c, inst.lotSize * (1 + (this.ticks % 3)), lt.side]];
      }
      depthCache.set(sym, b.update(lt.price, lt.side, tape, levels));
    }

    const quotes = this.ticks % 2 === 0 ? this.sim.getQuotes() : null;
    for (const c of this.clients.values()) {
      const u: [string, Bar][] = [];
      const seen = new Set<string>();
      for (const [key, s] of c.subs) {
        if (s.kind === "bars" && !seen.has(s.symbol)) {
          seen.add(s.symbol);
          const from = c.lastBarT.get(s.symbol) ?? curMinute;
          const ck = `${s.symbol}|${from}`;
          let ser = seriesCache.get(ck);
          if (!ser) seriesCache.set(ck, (ser = this.sim.series(s.symbol, from)));
          for (const b of ser) u.push([s.symbol, b]);
          if (ser.length) c.lastBarT.set(s.symbol, ser[ser.length - 1].t);
        } else if (s.kind === "depth") {
          const d = depthCache.get(s.symbol);
          if (d) {
            const n = s.levels;
            c.send({ t: "depth", key, d: n >= d.bids.length ? d : { ...d, bids: d.bids.slice(0, n), asks: d.asks.slice(0, n) } });
          }
        } else if (s.kind === "chain" && this.ticks % 4 === 0) {
          const ch = this.sim.getChain(s.root, s.expiry);
          if (ch) c.send({ t: "chain", key, c: ch });
        } else if (s.kind === "mflow" && this.ticks % 4 === 0) {
          const r = optionRoot(s.root);
          if (!r) continue;
          const from = c.lastFlowT.get(s.root) ?? curMinute;
          const flows = this.sim.flowsSince(r, from);
          if (flows.length) {
            c.send({ t: "mflow", root: s.root, flows });
            c.lastFlowT.set(s.root, flows[flows.length - 1].t);
          }
        }
      }
      if (u.length) c.send({ t: "bars", u });
      if (quotes) c.send({ t: "quotes", q: quotes });
      if (this.ticks % 4 === 0) c.send({ t: "clock", simTime: this.sim.simTime, speed: this.sim.speed });
    }
  }
}
