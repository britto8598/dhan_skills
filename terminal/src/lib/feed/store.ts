/**
 * Client-side market data store. Messages are applied immediately; listeners are
 * notified at most once per animation frame per topic, which keeps multi-chart
 * layouts at 60 FPS regardless of feed rate.
 */
import type { Bar, Chain, Depth, MinuteFlow, Quote, ServerMsg } from "./protocol";
import { BASE_INSTRUMENTS, getInstrument, type Instrument } from "../sim/instruments";

type Listener = () => void;

export interface DepthSample {
  t: number;
  d: Depth;
}

class MarketStore {
  bars = new Map<string, Bar[]>();
  quotes = new Map<string, Quote>();
  depth = new Map<string, Depth>();
  depthHist = new Map<string, DepthSample[]>();
  chains = new Map<string, Chain>();
  flows = new Map<string, MinuteFlow[]>();
  instruments = new Map<string, Instrument>(BASE_INSTRUMENTS.map((i) => [i.symbol, i]));
  simTime = Date.now();
  speed = 1;
  source: "mock" | "dhan" | "zerodha" = "mock";
  /** true once the backend's hello (with its clock) has arrived */
  ready = false;

  private versions = new Map<string, number>();
  private listeners = new Map<string, Set<Listener>>();
  private dirty = new Set<string>();
  private scheduled = false;

  version(topic: string): number {
    return this.versions.get(topic) ?? 0;
  }

  subscribe(topic: string, fn: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  touch(topic: string): void {
    this.versions.set(topic, (this.versions.get(topic) ?? 0) + 1);
    this.dirty.add(topic);
    if (!this.scheduled) {
      this.scheduled = true;
      const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
      raf(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const topics = [...this.dirty];
    this.dirty.clear();
    for (const t of topics) this.listeners.get(t)?.forEach((fn) => fn());
  }

  instrument(symbol: string): Instrument | undefined {
    return this.instruments.get(symbol) ?? getInstrument(symbol);
  }

  getBars(symbol: string): Bar[] {
    return this.bars.get(symbol) ?? [];
  }

  flowList(root: string): MinuteFlow[] {
    return this.flows.get(root) ?? [];
  }

  apply(msg: ServerMsg): void {
    switch (msg.t) {
      case "hello":
        for (const i of msg.instruments) this.instruments.set(i.symbol, i);
        this.simTime = msg.simTime;
        this.speed = msg.speed;
        this.source = msg.source;
        this.ready = true;
        this.touch("clock");
        break;
      case "clock":
        this.simTime = msg.simTime;
        this.speed = msg.speed;
        this.touch("clock");
        break;
      case "hist": {
        const cur = this.bars.get(msg.symbol);
        if (!cur || !cur.length || !msg.bars.length || msg.bars[0].t <= cur[0].t) {
          this.bars.set(msg.symbol, msg.bars.slice());
        } else {
          for (const b of msg.bars) upsertBar(cur, b);
        }
        this.touch(`bars:${msg.symbol}`);
        break;
      }
      case "bars": {
        const touched = new Set<string>();
        for (const [sym, bar] of msg.u) {
          let arr = this.bars.get(sym);
          if (!arr) this.bars.set(sym, (arr = []));
          upsertBar(arr, bar);
          touched.add(sym);
          if (bar.t > this.simTime - 60_000) this.simTime = Math.max(this.simTime, bar.t);
        }
        touched.forEach((s) => this.touch(`bars:${s}`));
        break;
      }
      case "quotes":
        for (const q of msg.q) this.quotes.set(q.s, q);
        this.touch("quotes");
        break;
      case "depth": {
        this.depth.set(msg.d.s, msg.d);
        let h = this.depthHist.get(msg.d.s);
        if (!h) this.depthHist.set(msg.d.s, (h = []));
        h.push({ t: msg.d.t, d: msg.d });
        if (h.length > 1200) h.splice(0, h.length - 1200);
        this.touch(`depth:${msg.d.s}`);
        break;
      }
      case "chain":
        this.chains.set(`${msg.c.root}:${msg.c.expiry}`, msg.c);
        this.touch(`chain:${msg.c.root}:${msg.c.expiry}`);
        break;
      case "mflow_hist": {
        const cur = this.flows.get(msg.root);
        if (!cur || !cur.length || !msg.flows.length || msg.flows[0].t <= cur[0].t) this.flows.set(msg.root, msg.flows.slice());
        else for (const f of msg.flows) upsertFlow(cur, f);
        this.touch(`mflow:${msg.root}`);
        break;
      }
      case "mflow": {
        let cur = this.flows.get(msg.root);
        if (!cur) this.flows.set(msg.root, (cur = []));
        for (const f of msg.flows) upsertFlow(cur, f);
        this.touch(`mflow:${msg.root}`);
        break;
      }
      default:
        break;
    }
  }
}

function upsertBar(arr: Bar[], bar: Bar): void {
  const n = arr.length;
  if (!n || bar.t > arr[n - 1].t) arr.push(bar);
  else if (bar.t === arr[n - 1].t) arr[n - 1] = bar;
  else {
    let lo = 0;
    let hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t === bar.t) {
        arr[mid] = bar;
        return;
      }
      if (arr[mid].t < bar.t) lo = mid + 1;
      else hi = mid - 1;
    }
    arr.splice(lo, 0, bar);
  }
}

function upsertFlow(arr: MinuteFlow[], f: MinuteFlow): void {
  const n = arr.length;
  if (!n || f.t > arr[n - 1].t) arr.push(f);
  else if (f.t === arr[n - 1].t) arr[n - 1] = f;
  else {
    const i = arr.findIndex((x) => x.t === f.t);
    if (i >= 0) arr[i] = f;
  }
}

export const market = new MarketStore();
export type { MarketStore };
