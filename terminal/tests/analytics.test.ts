import { test } from "node:test";
import assert from "node:assert/strict";
import type { Bar, MinuteFlow } from "../src/lib/feed/protocol";
import { valueArea, volumeProfile } from "../src/lib/analytics/profile";
import { footprintRows, stackedZones, autoRowSize, tickRowSize } from "../src/lib/analytics/footprint";
import { aggregate, bucketStart } from "../src/lib/data/aggregate";
import { buildTpo, tpoSegments } from "../src/lib/analytics/tpo";
import { deltaDivergence, cvd, vwap } from "../src/lib/analytics/delta";
import { flowArrows, aggregateFlows } from "../src/lib/analytics/moneyflow";
import { computeLevels, computeHud, defaultScalper, type DayPlan } from "../src/lib/analytics/scalper";
import { youtubeId } from "../src/lib/media";
import { sessionOpen, MIN_MS } from "../src/lib/sim/time";

const OPEN = sessionOpen(Date.UTC(2026, 8, 25, 6, 0)); // 25 Sep 2026 09:15 IST

function bar(i: number, o: number, c: number, cells: number[] = [], d = 0, v = 100): Bar {
  return { t: OPEN + i * MIN_MS, o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c, v, d, dmin: Math.min(0, d), dmax: Math.max(0, d), n: 10, cells };
}

test("value area expands from the POC toward heavier rows (70%)", () => {
  const va = valueArea(new Map([[100, 10], [105, 50], [110, 20], [115, 5], [120, 1]]), 5)!;
  assert.deepEqual(va, { poc: 105, val: 105, vah: 110 });
});

test("volume profile finds POC from footprint cells", () => {
  const vp = volumeProfile([bar(0, 100, 101, [100, 10, 5, 100.5, 40, 60, 101, 3, 2])], 0.5)!;
  assert.equal(vp.poc, 100.5);
  assert.equal(vp.total, 120);
});

test("footprint diagonal imbalance and stacked zones", () => {
  // rows 100..103: ask at p vs bid at p-1 row
  const b = bar(0, 100, 103, [100, 5, 1, 101, 1, 30, 102, 1, 40, 103, 1, 50]);
  const rows = footprintRows(b, 1, 3, "diagonal");
  assert.deepEqual(rows.map((r) => r.buyImb), [false, true, true, true]);
  assert.deepEqual(stackedZones(rows, 1, "buy", 3), [[101, 103]]);
  const flat = footprintRows(bar(1, 100, 101, [100, 1, 10]), 1, 3, "horizontal");
  assert.equal(flat[0].buyImb, true);
});

test("row sizes snap to the stored granularity", () => {
  assert.equal(tickRowSize(40, 0.05, 0.5), 2);
  assert.equal(tickRowSize(10, 0.05, 0.5), 0.5);
  assert.equal(tickRowSize(3, 0.05, 0.5), 0.5);
  assert.ok(autoRowSize(2, 0.5, 15) >= 7.5);
});

test("timeframe buckets align to 09:15 and merge bars", () => {
  assert.equal(bucketStart(OPEN + 7 * MIN_MS, 5), OPEN + 5 * MIN_MS);
  assert.equal(bucketStart(OPEN + 14 * MIN_MS, 15), OPEN);
  const src = [0, 1, 2, 3, 4, 5].map((i) => bar(i, 100 + i, 101 + i, [100 + i, 1, 2], i % 2 ? -10 : 20));
  const agg = aggregate("test-sym", src, 5);
  assert.equal(agg.length, 2);
  assert.equal(agg[0].subs.length, 5);
  assert.equal(agg[0].o, 100);
  assert.equal(agg[0].c, 105);
  assert.equal(agg[0].v, 500);
  assert.equal(agg[0].d, 40);
  assert.equal(agg[0].cells.length, 15);
  // incremental update of the last bar
  src.push(bar(6, 106, 90, [90, 50, 0], -50));
  const agg2 = aggregate("test-sym", src, 5);
  assert.equal(agg2.length, 2);
  assert.equal(agg2[1].c, 90);
});

test("TPO profile: IB, POC and split/merge segments", () => {
  const bars: Bar[] = [];
  for (let i = 0; i < 120; i++) bars.push(bar(i, 100 + (i % 7), 100 + ((i + 1) % 7)));
  const segs = tpoSegments(bars, [], []);
  assert.equal(segs.length, 1);
  const p = buildTpo(bars, segs[0].start, segs[0].end, 30, 1)!;
  assert.equal(p.ibHigh, 107);
  assert.equal(p.ibLow, 99);
  assert.ok(p.poc >= 99 && p.poc <= 107);
  const split = tpoSegments(bars, [], [OPEN + 60 * MIN_MS]);
  assert.equal(split.length, 2);
  assert.equal(split[1].start, OPEN + 60 * MIN_MS);
});

test("delta divergence flags price/delta disagreement", () => {
  const div = deltaDivergence([bar(0, 100, 105, [], -8000), bar(1, 105, 100, [], 9000), bar(2, 100, 101, [], 100)], 100, 75);
  assert.deepEqual([...div], [-1, 1, 0]);
  assert.deepEqual(cvd([bar(0, 1, 2, [], 5), bar(1, 1, 2, [], -2)]), [5, 3]);
  assert.ok(vwap([bar(0, 100, 102)])[0]!.vwap > 100);
});

test("flow arrows count strikes with a burst in a single minute", () => {
  const f = (i: number, rows: MinuteFlow["rows"]): MinuteFlow => ({ t: OPEN + i * MIN_MS, spot: 25000, rows });
  const flows = [
    f(0, [[25000, 10, 10, 10, 900, 100, 100], [24950, 10, 10, 10, 800, 80, 80], [24900, 10, 10, 10, 700, 60, 60]]),
    f(1, [[25000, 10, 300, 10, 10, 100, 100]]),
    f(2, [[25000, 10, 300, 10, 10, 100, 100]]), // 2 × 300 would pass a summed threshold, but not per minute
  ];
  const a = flowArrows(flows, 5, 500);
  assert.deepEqual(a.get(OPEN), { bull: 3, bear: 0 });
  const agg = aggregateFlows(flows, OPEN, OPEN + 10 * MIN_MS, 75);
  assert.ok(agg.totals.bull > agg.totals.bear);
});

test("scalper levels: synthetic future and break-even bands", () => {
  const cfg = { ...defaultScalper("NIFTY"), anchor: "09:20", offset: 50 };
  const day = OPEN - (9 * 60 + 15) * MIN_MS;
  const plan: DayPlan = { day, open: OPEN, end: OPEN + 375 * MIN_MS, anchorT: OPEN + 5 * MIN_MS, strike: 25000, expiry: "260929", ce: "c", pe: "p", ceItm: "ci", peItm: "pi" };
  const prevT = OPEN - 18 * 3600_000;
  const ce: Bar[] = [{ ...bar(0, 120, 120), t: prevT }, ...Array.from({ length: 10 }, (_, i) => bar(i, 130 + i, 131 + i))];
  const pe: Bar[] = [{ ...bar(0, 110, 110), t: prevT }, ...Array.from({ length: 10 }, (_, i) => bar(i, 100 - i, 99 - i))];
  const lv = computeLevels(plan, ce, pe, cfg);
  assert.equal(lv.bepPrevUp, 25230); // 25000 + 120 + 110
  assert.equal(lv.bepAnchorUp, 25000 + 135 + 95); // opens at 09:20
  assert.equal(lv.r1, lv.bepAnchorUp! + 50);
  assert.equal(lv.synthetic[0].v, 25000 + 131 - 99);
  const hud = computeHud(lv, ce, pe, cfg);
  assert.equal(hud.ce.chg, 140 - 120);
  assert.equal(hud.addedPremium, 140 - 120 + (90 - 110));
});

test("youtube ids from urls", () => {
  assert.equal(youtubeId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://www.youtube.com/live/abcdefghijk?si=x"), "abcdefghijk");
  assert.equal(youtubeId("dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(youtubeId("https://example.com/stream.mp3"), null);
});
