"use client";
import { useEffect, useState } from "react";
import { feed } from "@/lib/feed/client";
import { startSync, liveScreens, openScreen, on } from "@/lib/state/sync";
import { useWorkspace, type Screen } from "@/lib/state/workspace";
import { TopBar } from "./shell/TopBar";
import { TickerTape } from "./shell/TickerTape";
import { WidgetGrid } from "./grid/WidgetGrid";
import { FloatingLayer } from "./grid/FloatingLayer";
import { Btn } from "./ui";

function DetachedNotice() {
  const widgets = useWorkspace((s) => s.ws.widgets);
  const popout = useWorkspace((s) => s.popout);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 4000);
    const off = on("screens", () => tick((x) => x + 1));
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  const live = liveScreens();
  const orphans = ([1, 2] as const).map((s) => ({ s, ids: Object.values(widgets).filter((w) => w.screen === s).map((w) => w.id) })).filter((o) => o.ids.length && !live.includes(o.s));
  if (!orphans.length) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-warn/10 px-2 py-0.5 text-[11px] text-warn">
      {orphans.map((o) => (
        <span key={o.s} className="flex items-center gap-1.5">
          {o.ids.length} widget{o.ids.length > 1 ? "s" : ""} on Screen {o.s} (window closed)
          <Btn onClick={() => openScreen(o.s)}>Reopen</Btn>
          <Btn onClick={() => o.ids.forEach((id) => popout(id, 0))}>Dock back</Btn>
        </span>
      ))}
    </div>
  );
}

export default function Terminal({ screen }: { screen: Screen }) {
  useEffect(() => {
    feed.start();
    startSync(screen);
    document.title = screen ? `Screen ${screen} · OrderFlow Terminal` : "OrderFlow Terminal";
  }, [screen]);
  return (
    <div className="flex h-full flex-col">
      <TopBar screen={screen} />
      {screen === 0 && <TickerTape />}
      {screen === 0 && <DetachedNotice />}
      <WidgetGrid screen={screen} />
      <FloatingLayer screen={screen} />
    </div>
  );
}
