"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { market } from "@/lib/feed/store";
import { displayName, searchInstruments } from "@/lib/sim/instruments";
import { cx } from "../ui";

/** Compact symbol search: type "NIFTY", "RELI", or "NIFTY 25000 CE". */
export function SymbolSearch({ value, onChange, className }: { value: string; onChange: (s: string) => void; className?: string }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const results = useMemo(() => (open ? searchInstruments(q, market.simTime, 40) : []), [q, open]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  const pick = (s: string) => {
    onChange(s);
    setOpen(false);
    setQ("");
  };
  return (
    <div ref={ref} className={cx("no-drag relative", className)}>
      {open ? (
        <input
          autoFocus
          value={q}
          placeholder="Symbol / NIFTY 25000 CE"
          onChange={(e) => {
            setQ(e.target.value);
            setHi(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setHi((h) => Math.min(results.length - 1, h + 1));
            else if (e.key === "ArrowUp") setHi((h) => Math.max(0, h - 1));
            else if (e.key === "Enter" && results[hi]) pick(results[hi].symbol);
            else if (e.key === "Escape") setOpen(false);
          }}
          className="h-[20px] w-[170px] rounded-[3px] border border-accent bg-panel2 px-1.5 text-[11px] uppercase outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Change symbol"
          className="flex h-[20px] max-w-[190px] items-center gap-1 rounded-[3px] px-1.5 text-[11px] font-semibold hover:bg-panel3"
        >
          <span className="truncate">{displayName(value)}</span>
          <span className="text-[9px] text-dim">▼</span>
        </button>
      )}
      {open && (
        <div className="absolute top-[22px] left-0 z-[250] max-h-[320px] w-[280px] overflow-auto rounded border border-line2 bg-panel2 p-1 shadow-2xl shadow-black/70">
          {results.map((r, i) => (
            <button
              key={r.symbol}
              type="button"
              onMouseEnter={() => setHi(i)}
              onClick={() => pick(r.symbol)}
              className={cx("flex w-full items-center justify-between gap-2 rounded-[3px] px-2 py-1 text-left text-[11px]", i === hi && "bg-accent/20")}
            >
              <span className="font-semibold">{displayName(r.symbol)}</span>
              <span className="truncate text-[10px] text-muted">
                {r.kind} · {r.exchange}
              </span>
            </button>
          ))}
          {!results.length && <div className="px-2 py-1 text-[11px] text-dim">No matches</div>}
        </div>
      )}
    </div>
  );
}
