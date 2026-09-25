"use client";
import { useRef } from "react";
import { useWorkspace, type FloatRect, type Screen } from "@/lib/state/workspace";
import { WidgetFrame } from "./WidgetFrame";

/** Floating (picture-in-picture style) widgets that sit above the grid. */
export function FloatingLayer({ screen }: { screen: Screen }) {
  const widgets = useWorkspace((s) => s.ws.widgets);
  const floats = Object.values(widgets).filter((w) => w.float && w.screen === screen);
  return (
    <>
      {floats.map((w, k) => (
        <FloatWindow key={w.id} id={w.id} rect={w.float!} z={60 + k} screen={screen} />
      ))}
    </>
  );
}

function FloatWindow({ id, rect, z, screen }: { id: string; rect: FloatRect; z: number; screen: Screen }) {
  const setFloat = useWorkspace((s) => s.setFloat);
  const ref = useRef<HTMLDivElement>(null);
  const start = (e: React.PointerEvent, kind: "move" | "resize") => {
    const target = e.target as HTMLElement;
    if (kind === "move" && (!target.closest(".float-handle") || target.closest(".no-drag"))) return;
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const r0 = { ...rect };
    let cur = r0;
    const el = ref.current!;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      cur =
        kind === "move"
          ? { ...r0, x: Math.max(0, Math.min(window.innerWidth - 80, r0.x + dx)), y: Math.max(0, Math.min(window.innerHeight - 40, r0.y + dy)) }
          : { ...r0, w: Math.max(260, r0.w + dx), h: Math.max(160, r0.h + dy) };
      el.style.left = `${cur.x}px`;
      el.style.top = `${cur.y}px`;
      el.style.width = `${cur.w}px`;
      el.style.height = `${cur.h}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setFloat(id, cur);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div ref={ref} className="fixed" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: z }} onPointerDown={(e) => start(e, "move")}>
      <WidgetFrame id={id} screen={screen} />
      <div className="absolute right-0 bottom-0 h-3.5 w-3.5 cursor-se-resize" onPointerDown={(e) => { e.stopPropagation(); start(e, "resize"); }}>
        <div className="absolute right-[3px] bottom-[3px] h-1.5 w-1.5 border-r-2 border-b-2 border-[#4b5a6e]" />
      </div>
    </div>
  );
}
