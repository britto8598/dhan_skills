"use client";
import { useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { BASE_INSTRUMENTS } from "@/lib/sim/instruments";
import { useWorkspace } from "@/lib/state/workspace";
import { Check, Menu, MenuLabel, cx } from "../ui";
import { fmtPrice } from "../chart/theme";

export function TickerTape() {
  useTopic("quotes", 1000);
  const ticker = useWorkspace((s) => s.ws.ticker);
  const setTicker = useWorkspace((s) => s.setTicker);
  const setChannelSymbol = useWorkspace((s) => s.setChannelSymbol);
  const items = ticker.symbols
    .map((s) => market.quotes.get(s))
    .filter((q): q is NonNullable<typeof q> => !!q)
    .map((q) => {
      const inst = market.instrument(q.s);
      const chg = q.ltp - q.pc;
      const pct = q.pc ? (chg / q.pc) * 100 : 0;
      return { s: q.s, ltp: fmtPrice(q.ltp, inst?.tickSize), chg, pct };
    });
  return (
    <div className="flex h-[22px] shrink-0 items-center border-b border-line bg-[#0a0e14] text-[11px]">
      <div className="relative flex-1 overflow-hidden whitespace-nowrap">
        {ticker.enabled && items.length > 0 ? (
          <div className="marquee" style={{ ["--marquee-duration" as string]: `${Math.max(10, 200 - ticker.speed * 1.8)}s` }}>
            {[0, 1].map((dup) => (
              <div key={dup} className="flex" aria-hidden={dup === 1}>
                {items.map((it) => (
                  <button
                    key={`${dup}-${it.s}`}
                    type="button"
                    title={`Link ${it.s} to the red channel`}
                    onClick={() => setChannelSymbol("red", it.s)}
                    className="num flex items-center gap-1.5 px-3 hover:bg-panel3"
                  >
                    <span className="font-semibold text-fg/90">{it.s}</span>
                    <span>{it.ltp}</span>
                    <span className={cx(it.chg >= 0 ? "text-up" : "text-down")}>
                      {it.chg >= 0 ? "▲" : "▼"} {Math.abs(it.chg).toFixed(2)} ({it.pct >= 0 ? "+" : ""}
                      {it.pct.toFixed(2)}%)
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <span className="px-3 text-dim">{ticker.enabled ? "Waiting for quotes…" : "Ticker paused"}</span>
        )}
      </div>
      <Menu trigger={<>⚙</>} title="Customize ticker tape" align="right" width={230} className="border-l border-line">
        <MenuLabel>Ticker tape</MenuLabel>
        <div className="px-2">
          <Check checked={ticker.enabled} onChange={(v) => setTicker({ enabled: v })} label="Scroll ticker" />
          <label className="flex items-center gap-2 py-1 text-[11px]">
            <span className="text-muted">Speed</span>
            <input type="range" min={10} max={100} value={ticker.speed} onChange={(e) => setTicker({ speed: Number(e.target.value) })} className="flex-1 accent-accent" />
          </label>
        </div>
        <MenuLabel>Symbols</MenuLabel>
        <div className="grid grid-cols-2 px-2">
          {BASE_INSTRUMENTS.map((i) => (
            <Check
              key={i.symbol}
              checked={ticker.symbols.includes(i.symbol)}
              label={i.symbol}
              onChange={(v) => setTicker({ symbols: v ? [...ticker.symbols, i.symbol] : ticker.symbols.filter((s) => s !== i.symbol) })}
            />
          ))}
        </div>
      </Menu>
    </div>
  );
}
