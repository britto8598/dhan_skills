"use client";
import { useSub, useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import type { ChainRow } from "@/lib/feed/protocol";
import { atmStrike, expiriesFor, optionRoot, optionSymbol, rootOf } from "@/lib/sim/instruments";
import { useWorkspace } from "@/lib/state/workspace";
import { fmtNum } from "../chart/theme";
import { Empty, Sel, cx } from "../ui";
import type { WidgetProps } from "./ChartWidget";

/** Interactive option chain. Click a CE/PE cell (or strike = CE, shift = PE) to link that option. */
export default function OptionChain({ id, symbol, settings }: WidgetProps) {
  const root = rootOf(symbol) && optionRoot(rootOf(symbol)!) ? rootOf(symbol)! : "NIFTY";
  useTopic("clock", 5000);
  const exps = expiriesFor(root, market.simTime, 4);
  const expSetting = (settings.expiry as string) ?? "";
  const expiry = exps.includes(expSetting) ? expSetting : exps[0];
  const span = Number(settings.strikes) || 12;
  const updateSettings = useWorkspace((s) => s.updateSettings);
  const setSymbol = useWorkspace((s) => s.setSymbol);
  useSub(expiry ? { kind: "chain", root, expiry } : null);
  useTopic(`chain:${root}:${expiry}`, 500);
  const chain = market.chains.get(`${root}:${expiry}`);

  if (!chain) return <Empty>Loading option chain…</Empty>;
  const atm = atmStrike(root, chain.spot);
  const ai = chain.rows.findIndex((r) => r.k === atm);
  const rows = chain.rows.slice(Math.max(0, ai - span), ai + span + 1);
  const atmRow = chain.rows[ai];
  const synthetic = atmRow ? atmRow.k + atmRow.ce.ltp - atmRow.pe.ltp : null;
  const ceOiSum = chain.rows.reduce((a, r) => a + r.ce.oi, 0);
  const peOiSum = chain.rows.reduce((a, r) => a + r.pe.oi, 0);
  const pcr = ceOiSum ? peOiSum / ceOiSum : 0;
  const maxPain = chain.rows.reduce(
    (best, x) => {
      const pain = chain.rows.reduce((a, r) => a + Math.max(x.k - r.k, 0) * r.ce.oi + Math.max(r.k - x.k, 0) * r.pe.oi, 0);
      return pain < best.pain ? { k: x.k, pain } : best;
    },
    { k: 0, pain: Infinity },
  ).k;
  let maxCeOi = 1;
  let maxPeOi = 1;
  let maxCeChg = 1;
  let maxPeChg = 1;
  for (const r of rows) {
    maxCeOi = Math.max(maxCeOi, r.ce.oi);
    maxPeOi = Math.max(maxPeOi, r.pe.oi);
    maxCeChg = Math.max(maxCeChg, Math.abs(r.ce.oiChg));
    maxPeChg = Math.max(maxPeChg, Math.abs(r.pe.oiChg));
  }
  const pick = (k: number, t: "CE" | "PE") => setSymbol(id, optionSymbol(root, expiry, k, t));
  const lot = optionRoot(root)!.lotSize;

  return (
    <div className="flex h-full flex-col text-[11px]">
      <div className="num flex h-[24px] shrink-0 items-center gap-3 overflow-x-auto border-b border-line px-2 whitespace-nowrap">
        <Sel value={expiry} onChange={(e) => updateSettings(id, { expiry: e })} options={exps.map((e) => ({ value: e, label: `Exp ${e}` }))} />
        <Sel value={span} onChange={(v) => updateSettings(id, { strikes: v })} options={[6, 10, 12, 15].map((v) => ({ value: v, label: `±${v}` }))} />
        <span>
          Spot <b>{chain.spot.toFixed(2)}</b>
        </span>
        <span className="text-muted">
          Fut <span className="text-fg">{chain.fut.toFixed(2)}</span>
        </span>
        <span className="text-muted">
          Synth <span className="text-warn">{synthetic?.toFixed(2)}</span>
        </span>
        <span className="text-muted">
          ATM IV <span className="text-fg">{chain.atmIv.toFixed(2)}</span>
        </span>
        <span className="text-muted">
          PCR <span className={pcr >= 1 ? "text-up" : "text-down"}>{pcr.toFixed(2)}</span>
        </span>
        <span className="text-muted">
          Max pain <span className="text-fg">{maxPain}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="num w-full border-collapse text-right whitespace-nowrap">
          <thead className="sticky top-0 z-10 bg-panel2 text-[10px] text-dim">
            <tr>
              <th className="px-1 py-0.5 font-normal">OI</th>
              <th className="px-1 font-normal">ΔOI</th>
              <th className="px-1 font-normal">Vol</th>
              <th className="px-1 font-normal">IV</th>
              <th className="px-1 font-normal text-up">CE LTP</th>
              <th className="bg-panel3 px-1 text-center font-normal">Strike</th>
              <th className="px-1 font-normal text-down">PE LTP</th>
              <th className="px-1 font-normal">IV</th>
              <th className="px-1 font-normal">Vol</th>
              <th className="px-1 font-normal">ΔOI</th>
              <th className="px-1 font-normal">OI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: ChainRow) => {
              const ceItm = r.k < chain.spot;
              const peItm = r.k > chain.spot;
              const isAtm = r.k === atm;
              const ceCls = cx("cursor-pointer px-1 py-[2px] hover:bg-accent/20", ceItm && "bg-[#2a2410]/60");
              const peCls = cx("cursor-pointer px-1 py-[2px] hover:bg-accent/20", peItm && "bg-[#2a2410]/60");
              return (
                <tr key={r.k} className={cx("border-b border-line/60", isAtm && "outline outline-1 -outline-offset-1 outline-accent/60")}>
                  <td className={cx(ceCls, "relative")} onClick={() => pick(r.k, "CE")}>
                    <span className="absolute inset-y-[3px] right-0 bg-down/25" style={{ width: `${(r.ce.oi / maxCeOi) * 100}%` }} />
                    <span className={cx("relative", r.ce.oi === maxCeOi && "font-bold text-down")}>{fmtNum(r.ce.oi / lot)}</span>
                  </td>
                  <td className={ceCls} onClick={() => pick(r.k, "CE")}>
                    <span className={r.ce.oiChg >= 0 ? "text-up" : "text-down"} style={{ opacity: 0.5 + (0.5 * Math.abs(r.ce.oiChg)) / maxCeChg }}>
                      {fmtNum(r.ce.oiChg / lot)}
                    </span>
                  </td>
                  <td className={ceCls} onClick={() => pick(r.k, "CE")}>
                    {fmtNum(r.ce.vol / lot)}
                  </td>
                  <td className={cx(ceCls, "text-muted")} onClick={() => pick(r.k, "CE")}>
                    {r.ce.iv.toFixed(1)}
                  </td>
                  <td className={ceCls} onClick={() => pick(r.k, "CE")} title={`Δ ${r.ce.delta} · bid ${r.ce.bid} / ask ${r.ce.ask}`}>
                    <span className="text-fg">{r.ce.ltp.toFixed(2)}</span> <span className={cx("text-[10px]", r.ce.chg >= 0 ? "text-up" : "text-down")}>{r.ce.chg >= 0 ? "+" : ""}{r.ce.chg.toFixed(1)}</span>
                  </td>
                  <td
                    className={cx("cursor-pointer bg-panel3 px-1 text-center font-semibold hover:bg-accent/30", isAtm && "text-[#9ec5ff]", r.k === maxPain && "underline decoration-warn")}
                    onClick={(e) => pick(r.k, e.shiftKey ? "PE" : "CE")}
                    title="Click = link CE, shift-click = link PE"
                  >
                    {r.k}
                  </td>
                  <td className={peCls} onClick={() => pick(r.k, "PE")} title={`Δ ${r.pe.delta} · bid ${r.pe.bid} / ask ${r.pe.ask}`}>
                    <span className="text-fg">{r.pe.ltp.toFixed(2)}</span> <span className={cx("text-[10px]", r.pe.chg >= 0 ? "text-up" : "text-down")}>{r.pe.chg >= 0 ? "+" : ""}{r.pe.chg.toFixed(1)}</span>
                  </td>
                  <td className={cx(peCls, "text-muted")} onClick={() => pick(r.k, "PE")}>
                    {r.pe.iv.toFixed(1)}
                  </td>
                  <td className={peCls} onClick={() => pick(r.k, "PE")}>
                    {fmtNum(r.pe.vol / lot)}
                  </td>
                  <td className={peCls} onClick={() => pick(r.k, "PE")}>
                    <span className={r.pe.oiChg >= 0 ? "text-up" : "text-down"} style={{ opacity: 0.5 + (0.5 * Math.abs(r.pe.oiChg)) / maxPeChg }}>
                      {fmtNum(r.pe.oiChg / lot)}
                    </span>
                  </td>
                  <td className={cx(peCls, "relative")} onClick={() => pick(r.k, "PE")}>
                    <span className="absolute inset-y-[3px] left-0 bg-up/25" style={{ width: `${(r.pe.oi / maxPeOi) * 100}%` }} />
                    <span className={cx("relative", r.pe.oi === maxPeOi && "font-bold text-up")}>{fmtNum(r.pe.oi / lot)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="px-2 py-1 text-[10px] text-dim">OI / volume in lots · shaded = ITM · click a cell to link the option to charts on this channel</div>
      </div>
    </div>
  );
}
