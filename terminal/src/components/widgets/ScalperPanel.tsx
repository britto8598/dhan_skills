"use client";
import { useRef, useState } from "react";
import { useWorkspace } from "@/lib/state/workspace";
import { OPTION_ROOTS, expiriesFor } from "@/lib/sim/instruments";
import { market } from "@/lib/feed/store";
import type { HudData, ScalperConfig } from "@/lib/analytics/scalper";
import { Btn, Check, Field, Modal, Seg, Sel, TextInput, cx } from "../ui";

function f(v: number | null | undefined, d = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d);
}

/** Floating HUD table over the chart canvas (OG_Scalper / ATM Added Premium). */
export function ScalperHud({ hud, cfg, pos, onMove, onEdit }: { hud: HudData; cfg: ScalperConfig; pos: { x: number; y: number }; onMove: (p: { x: number; y: number }) => void; onEdit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const p0 = { ...pos };
    let cur = p0;
    const move = (ev: PointerEvent) => {
      // the HUD is anchored to the right edge, so dragging left grows the right offset
      cur = { x: Math.max(0, p0.x - (ev.clientX - sx)), y: Math.max(0, p0.y + ev.clientY - sy) };
      if (ref.current) {
        ref.current.style.right = `${cur.x}px`;
        ref.current.style.top = `${cur.y}px`;
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onMove(cur);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const chg = (v: number | null) => <span className={cx("num", v === null ? "" : v >= 0 ? "text-up" : "text-down")}>{v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}`}</span>;
  return (
    <div
      ref={ref}
      onPointerDown={down}
      className="absolute z-10 cursor-move rounded border border-line2 bg-[#0b1017]/92 text-[10.5px] shadow-xl shadow-black/60 backdrop-blur-sm select-none"
      style={{ right: pos.x, top: pos.y }}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-2 py-1">
        <span className="font-semibold text-[#9ec5ff]">
          OG_Scalper · {cfg.root} {hud.strike} · {hud.expiry}
        </span>
        <button type="button" onClick={onEdit} className="text-muted hover:text-fg" title="Scalper inputs">
          ⚙
        </button>
      </div>
      <table className="num w-full">
        <thead className="text-dim">
          <tr>
            <th className="px-2 py-0.5 text-left font-normal">ATM</th>
            <th className="px-2 text-right font-normal">Prev C</th>
            <th className="px-2 text-right font-normal">LTP</th>
            <th className="px-2 text-right font-normal">BEP</th>
            <th className="px-2 text-right font-normal">Chg</th>
            <th className="px-2 text-right font-normal">SL</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="px-2 py-0.5 text-up">CE</td>
            <td className="px-2 text-right">{f(hud.ce.pc)}</td>
            <td className="px-2 text-right text-fg">{f(hud.ce.ltp)}</td>
            <td className="px-2 text-right">{f(hud.ce.bep, 1)}</td>
            <td className="px-2 text-right">{chg(hud.ce.chg)}</td>
            <td className="px-2 text-right text-down/90">{f(hud.ce.sl)}</td>
          </tr>
          <tr>
            <td className="px-2 py-0.5 text-down">PE</td>
            <td className="px-2 text-right">{f(hud.pe.pc)}</td>
            <td className="px-2 text-right text-fg">{f(hud.pe.ltp)}</td>
            <td className="px-2 text-right">{f(hud.pe.bep, 1)}</td>
            <td className="px-2 text-right">{chg(hud.pe.chg)}</td>
            <td className="px-2 text-right text-down/90">{f(hud.pe.sl)}</td>
          </tr>
        </tbody>
      </table>
      <div className="num grid grid-cols-2 gap-x-3 border-t border-line px-2 py-1">
        <span className="text-muted">Total Added Premium</span>
        <span className="text-right">{chg(hud.addedPremium)}</span>
        <span className="text-muted">Straddle now / {cfg.anchor}</span>
        <span className="text-right">
          {f(hud.straddle)} / {f(hud.anchorStraddle)}
        </span>
        <span className="text-muted">Synthetic Future</span>
        <span className="text-right text-warn">{f(hud.synthetic, 1)}</span>
      </div>
    </div>
  );
}

export function ScalperInputs({ onClose, chartRoot }: { onClose: () => void; chartRoot?: string }) {
  const cfg = useWorkspace((s) => s.ws.scalper);
  const setScalper = useWorkspace((s) => s.setScalper);
  const [d, setD] = useState<ScalperConfig>({ ...cfg, root: cfg.root || chartRoot || "NIFTY" });
  const exps = expiriesFor(d.root, market.simTime, 4);
  const anchors = ["09:15", "09:20", "09:30"];
  const custom = !anchors.includes(d.anchor);
  const set = (p: Partial<ScalperConfig>) => setD((x) => ({ ...x, ...p }));
  return (
    <Modal title="Scalper inputs — synthetic future, BEP & straddle overlays" onClose={onClose} width={560}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Stock / index name">
          <Sel value={d.root} onChange={(root) => set({ root, expiry: "", baseStrike: 0 })} options={OPTION_ROOTS.map((r) => ({ value: r.root, label: r.root }))} />
        </Field>
        <Field label="Expiry (YYMMDD)" hint="Empty = nearest expiry each day">
          <div className="flex gap-1">
            <TextInput value={d.expiry} placeholder={exps[0]} onChange={(e) => set({ expiry: e.target.value.replace(/\D/g, "").slice(0, 6) })} className="w-[90px]" />
            <Sel value={d.expiry} onChange={(expiry) => set({ expiry })} options={[{ value: "", label: "Nearest" }, ...exps.map((e) => ({ value: e, label: e }))]} />
          </div>
        </Field>
        <Field label="Base strike" hint="0 = ATM at the anchor time">
          <TextInput type="number" value={d.baseStrike} onChange={(e) => set({ baseStrike: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Base offset points" hint="R1/R2 and S1/S2 distance from the BEP">
          <TextInput type="number" value={d.offset} onChange={(e) => set({ offset: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="SL points" hint="Premium stop shown in the HUD">
          <TextInput type="number" value={d.slPoints} onChange={(e) => set({ slPoints: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Straddle time anchor">
          <div className="flex items-center gap-1">
            <Seg value={custom ? "custom" : d.anchor} onChange={(v) => set({ anchor: v === "custom" ? "09:45" : v })} options={[...anchors.map((a) => ({ value: a, label: a })), { value: "custom", label: "Custom" }]} />
            {custom && <TextInput value={d.anchor} onChange={(e) => set({ anchor: e.target.value })} className="w-[64px]" placeholder="HH:MM" />}
          </div>
        </Field>
        <Field label="Days to show">
          <Seg value={d.daysToShow} onChange={(v) => set({ daysToShow: v })} options={[1, 2, 3, 5].map((n) => ({ value: n, label: String(n) }))} />
        </Field>
        <Field label="Option candles display">
          <Seg
            value={d.optionMode}
            onChange={(v) => set({ optionMode: v })}
            options={[
              { value: "pane", label: "Sub-pane" },
              { value: "overlay", label: "Overlay" },
            ]}
          />
        </Field>
        <div className="flex flex-col">
          <span className="mb-1 text-[11px] text-muted">Overlay lines</span>
          <Check checked={d.showSynthetic} onChange={(v) => set({ showSynthetic: v })} label="Synthetic future midline" />
          <Check checked={d.showBepPrev} onChange={(v) => set({ showBepPrev: v })} label="BEP (prev close straddle)" />
          <Check checked={d.showBepAnchor} onChange={(v) => set({ showBepAnchor: v })} label={`BEP (${d.anchor} straddle)`} />
          <Check checked={d.showRanges} onChange={(v) => set({ showRanges: v })} label="R1/R2 · S1/S2 ranges" />
          <Check checked={d.showHud} onChange={(v) => set({ showHud: v })} label="HUD table" />
        </div>
        <div className="flex flex-col">
          <span className="mb-1 text-[11px] text-muted">Option candles</span>
          <Check checked={d.ceAtm} onChange={(v) => set({ ceAtm: v })} label="ATM Call (CE)" />
          <Check checked={d.peAtm} onChange={(v) => set({ peAtm: v })} label="ATM Put (PE)" />
          <Check checked={d.ceItm} onChange={(v) => set({ ceItm: v })} label="CE ITM (K − 1 step)" />
          <Check checked={d.peItm} onChange={(v) => set({ peItm: v })} label="PE ITM (K + 1 step)" />
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn
          active
          onClick={() => {
            setScalper(d);
            onClose();
          }}
        >
          Apply
        </Btn>
      </div>
    </Modal>
  );
}
