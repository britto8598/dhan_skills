/**
 * Order-by-order (L3) book simulator for the DOM widget. Each price level holds a
 * FIFO queue of order sizes; prints from the market simulator consume the queue
 * front, so the client can track queue position. Also produces liquidity events:
 * pulled walls, stacking, and iceberg refills.
 */
import type { Depth, DepthEvent, DepthLevel } from "../feed/protocol";
import { expo, type Rng } from "./rng";

interface Level {
  orders: number[];
  iceberg?: { display: number; reserve: number };
  spoof?: { qty: number; ttl: number };
}

export class DepthBook {
  private bids = new Map<number, Level>();
  private asks = new Map<number, Level>();
  private maxLevels = 20;

  constructor(
    public readonly symbol: string,
    private tick: number,
    private lot: number,
    private rng: Rng,
    private meanLots = 4,
  ) {}

  private idx(p: number): number {
    return Math.round(p / this.tick);
  }

  private price(i: number): number {
    return Math.round(i * this.tick * 1e6) / 1e6;
  }

  private newLevel(distance: number, i: number): Level {
    const r = this.rng;
    const count = 1 + Math.floor(expo(r, 3 + distance * 0.05));
    const orders: number[] = [];
    for (let k = 0; k < count; k++) orders.push((1 + Math.floor(expo(r, this.meanLots))) * this.lot);
    if (i % 100 === 0) orders.push((20 + Math.floor(r() * 60)) * this.lot); // round-number wall
    const lvl: Level = { orders };
    if (distance < 6 && r() < 0.02) lvl.iceberg = { display: (3 + Math.floor(r() * 5)) * this.lot, reserve: (80 + Math.floor(r() * 200)) * this.lot };
    return lvl;
  }

  private consume(book: Map<number, Level>, i: number, qty: number, events: DepthEvent[], side: "bid" | "ask"): void {
    const lvl = book.get(i);
    if (!lvl) return;
    let left = qty;
    while (left > 0 && lvl.orders.length) {
      const take = Math.min(left, lvl.orders[0]);
      lvl.orders[0] -= take;
      left -= take;
      if (lvl.orders[0] <= 0) lvl.orders.shift();
    }
    if (lvl.iceberg && lvl.iceberg.reserve > 0 && lvl.orders.length === 0) {
      const refill = Math.min(lvl.iceberg.display, lvl.iceberg.reserve);
      lvl.iceberg.reserve -= refill;
      lvl.orders.push(refill);
      events.push({ type: "iceberg", price: this.price(i), qty: refill, side });
    }
  }

  update(ltp: number, lastSide: 1 | -1, tape: [number, number, 1 | -1][], levels: number): Depth {
    this.maxLevels = Math.max(20, Math.min(200, levels));
    const events: DepthEvent[] = [];
    const traded = new Map<number, [number, number]>();

    for (const [p, q, s] of tape) {
      const i = this.idx(p);
      const tr = traded.get(i) ?? [0, 0];
      tr[s > 0 ? 0 : 1] += q;
      traded.set(i, tr);
      if (s > 0) this.consume(this.asks, i, q, events, "ask");
      else this.consume(this.bids, i, q, events, "bid");
    }

    const li = this.idx(ltp);
    const A = lastSide > 0 ? li : li + 1;
    const B = A - 1;
    for (const i of [...this.bids.keys()]) if (i >= A || B - i > this.maxLevels + 20) this.bids.delete(i);
    for (const i of [...this.asks.keys()]) if (i <= B || i - A > this.maxLevels + 20) this.asks.delete(i);
    for (let k = 0; k < this.maxLevels; k++) {
      if (!this.bids.has(B - k)) this.bids.set(B - k, this.newLevel(k, B - k));
      if (!this.asks.has(A + k)) this.asks.set(A + k, this.newLevel(k, A + k));
    }

    const r = this.rng;
    const churn = (book: Map<number, Level>, touch: number, dir: number, side: "bid" | "ask") => {
      for (let k = 0; k < Math.min(40, this.maxLevels); k++) {
        const i = touch + dir * k;
        const lvl = book.get(i);
        if (!lvl) continue;
        const act = 1 / (1 + k * 0.15);
        if (r() < 0.1 * act) {
          const q = (1 + Math.floor(expo(r, this.meanLots))) * this.lot;
          lvl.orders.push(q);
          if (q >= 15 * this.lot) events.push({ type: "stack", price: this.price(i), qty: q, side });
        }
        if (lvl.orders.length > 1 && r() < 0.08 * act) {
          const j = 1 + Math.floor(r() * (lvl.orders.length - 1));
          const q = lvl.orders.splice(j, 1)[0];
          if (q >= 15 * this.lot) events.push({ type: "pull", price: this.price(i), qty: q, side });
        }
        if (!lvl.spoof && k > 2 && k < 15 && r() < 0.004) {
          const q = (25 + Math.floor(r() * 60)) * this.lot;
          lvl.spoof = { qty: q, ttl: 4 + Math.floor(r() * 12) };
          lvl.orders.push(q);
          events.push({ type: "stack", price: this.price(i), qty: q, side });
        } else if (lvl.spoof && --lvl.spoof.ttl <= 0) {
          const at = lvl.orders.lastIndexOf(lvl.spoof.qty);
          if (at >= 0) {
            lvl.orders.splice(at, 1);
            events.push({ type: "pull", price: this.price(i), qty: lvl.spoof.qty, side });
          }
          lvl.spoof = undefined;
        }
      }
    };
    churn(this.bids, B, -1, "bid");
    churn(this.asks, A, 1, "ask");

    const snap = (book: Map<number, Level>, start: number, dir: number, n: number): DepthLevel[] => {
      const out: DepthLevel[] = [];
      for (let k = 0; k < n; k++) {
        const lvl = book.get(start + dir * k);
        if (!lvl) continue;
        const qty = lvl.orders.reduce((a, b) => a + b, 0);
        const row: DepthLevel = [this.price(start + dir * k), qty, lvl.orders.length];
        if (n > 5) row.push(...lvl.orders.slice(0, 12));
        out.push(row);
      }
      return out;
    };
    const n = Math.min(levels, this.maxLevels);
    return {
      s: this.symbol,
      t: Date.now(),
      ltp,
      bids: snap(this.bids, B, -1, n),
      asks: snap(this.asks, A, 1, n),
      traded: [...traded.entries()].map(([i, [b, s]]) => [this.price(i), b, s]),
      events,
    };
  }
}
