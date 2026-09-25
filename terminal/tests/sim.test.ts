import { test } from "node:test";
import assert from "node:assert/strict";
import { MarketSim } from "../src/lib/sim/market";
import { SimHost } from "../src/lib/sim/host";
import { atmStrike, expiriesFor, optionSymbol, parseOption } from "../src/lib/sim/instruments";
import type { ServerMsg } from "../src/lib/feed/protocol";

const NOW = Date.UTC(2026, 8, 25, 14, 0); // Friday 19:30 IST → replay session from 12:00

test("history joins the live series without gaps and is deterministic", () => {
  const a = new MarketSim({ now: NOW });
  const b = new MarketSim({ now: NOW });
  const ha = a.getHistory("NIFTY-FUT", 3);
  const hb = b.getHistory("NIFTY-FUT", 3);
  assert.deepEqual(ha.slice(0, 50), hb.slice(0, 50));
  let jumps = 0;
  for (let i = 1; i < ha.length; i++) if (ha[i].t - ha[i - 1].t === 60_000 && Math.abs(ha[i].o - ha[i - 1].c) > 0.051) jumps++;
  assert.equal(jumps, 0);
  // every bar's cells add up to its volume
  for (const bar of ha.slice(-20)) {
    let v = 0;
    for (let i = 0; i < bar.cells.length; i += 3) v += bar.cells[i + 1] + bar.cells[i + 2];
    assert.equal(v, bar.v);
  }
});

test("live stepping closes minute bars and keeps quotes consistent", () => {
  const sim = new MarketSim({ now: NOW });
  for (let i = 0; i < 300; i++) sim.step(250);
  const live = sim.series("NIFTY-FUT", sim.liveStart);
  assert.ok(live.length >= 2);
  const q = sim.getQuotes().find((x) => x.s === "NIFTY-FUT")!;
  assert.equal(q.ltp, live[live.length - 1].c);
});

test("option chain and option bars are priced consistently", () => {
  const sim = new MarketSim({ now: NOW });
  const exp = expiriesFor("NIFTY", sim.simTime, 1)[0];
  const ch = sim.getChain("NIFTY", exp)!;
  assert.equal(ch.rows.length, 31);
  for (let i = 1; i < ch.rows.length; i++) {
    assert.ok(ch.rows[i].ce.ltp <= ch.rows[i - 1].ce.ltp, "CE premium falls with strike");
    assert.ok(ch.rows[i].pe.ltp >= ch.rows[i - 1].pe.ltp, "PE premium rises with strike");
  }
  const sym = optionSymbol("NIFTY", exp, atmStrike("NIFTY", ch.spot), "CE");
  assert.deepEqual(parseOption(sym)?.type, "CE");
  const bars = sim.getHistory(sym, 1);
  assert.ok(bars.length > 100);
  assert.ok(bars.every((b) => b.h >= b.l && b.v >= 0));
});

test("host serves hello, history and live updates to a client", () => {
  const host = new SimHost(new MarketSim({ now: NOW }));
  const msgs: ServerMsg[] = [];
  host.addClient("c1", (m) => msgs.push(m));
  host.handle("c1", { op: "hello" });
  host.handle("c1", { op: "sub", key: "k1", sub: { kind: "bars", symbol: "NIFTY", days: 1 } });
  host.handle("c1", { op: "sub", key: "k2", sub: { kind: "depth", symbol: "NIFTY-FUT", levels: 20 } });
  host.handle("c1", { op: "sub", key: "k3", sub: { kind: "mflow", root: "NIFTY", days: 1 } });
  for (let i = 0; i < 4; i++) (host as unknown as { tick(): void }).tick();
  const types = new Set(msgs.map((m) => m.t));
  for (const t of ["hello", "quotes", "hist", "bars", "depth", "mflow_hist"]) assert.ok(types.has(t as ServerMsg["t"]), `missing ${t}`);
  const depth = msgs.find((m) => m.t === "depth") as Extract<ServerMsg, { t: "depth" }>;
  assert.ok(depth.d.bids[0][0] < depth.d.asks[0][0], "book is not crossed");
  assert.equal(depth.d.bids.length, 20);
});
