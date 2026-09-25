"use client";
import { useMemo } from "react";
import ReactGridLayout from "react-grid-layout";
import { GRID_COLS, GRID_ROWS, useWorkspace, type GridItem, type Screen } from "@/lib/state/workspace";
import { useSize } from "../ui";
import { WidgetFrame } from "./WidgetFrame";

export function WidgetGrid({ screen }: { screen: Screen }) {
  const [ref, size] = useSize<HTMLDivElement>();
  const layout = useWorkspace((s) => s.ws.layouts[screen]);
  const widgets = useWorkspace((s) => s.ws.widgets);
  const setLayout = useWorkspace((s) => s.setLayout);
  const items = useMemo(() => layout.filter((l) => widgets[l.i] && !widgets[l.i].float && widgets[l.i].screen === screen), [layout, widgets, screen]);
  const rowHeight = Math.max(20, Math.floor(size.h / GRID_ROWS));
  const empty = items.length === 0;
  return (
    <div ref={ref} className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
      {size.w > 0 && !empty && (
        <ReactGridLayout
          layout={items}
          width={size.w}
          gridConfig={{ cols: GRID_COLS, rowHeight, margin: [0, 0], containerPadding: [0, 0] }}
          dragConfig={{ enabled: true, handle: ".drag-handle", cancel: ".no-drag" }}
          resizeConfig={{ enabled: true, handles: ["se", "e", "s"] }}
          onLayoutChange={(l) => {
            const next = l.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })) as GridItem[];
            const cur = items.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));
            if (JSON.stringify(next) !== JSON.stringify(cur)) setLayout(screen, next);
          }}
        >
          {items.map((it) => (
            <div key={it.i}>
              <WidgetFrame id={it.i} screen={screen} />
            </div>
          ))}
        </ReactGridLayout>
      )}
      {empty && (
        <div className="flex h-full items-center justify-center text-[12px] text-muted">
          {screen === 0 ? "No widgets — pick a layout preset or add a widget from the toolbar." : `Screen ${screen} is empty — move widgets here with their ⧉ button.`}
        </div>
      )}
    </div>
  );
}
