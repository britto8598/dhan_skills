"use client";
import { useRef, useState } from "react";
import { feed, useFeed, type BrokerName, type FeedMode } from "@/lib/feed/client";
import { useTopic } from "@/lib/feed/hooks";
import { market } from "@/lib/feed/store";
import { fmtDate, fmtTime } from "@/lib/sim/time";
import {
  MAX_TILES,
  PRESET_LABELS,
  WIDGET_LABELS,
  presetCells,
  useWorkspace,
  type Preset,
  type Range,
  type Screen,
  type TF,
  type WidgetType,
} from "@/lib/state/workspace";
import { openScreen } from "@/lib/state/sync";
import { Btn, Field, Menu, MenuItem, MenuLabel, Modal, Seg, Sel, TextInput, cx } from "../ui";

function StatusDot({ status }: { status: string }) {
  const color = status === "connected" ? "bg-up" : status === "trial" ? "bg-warn" : status === "connecting" ? "bg-accent animate-pulse" : "bg-down";
  return <span className={cx("inline-block h-2 w-2 rounded-full", color)} />;
}

const STATUS_LABEL: Record<string, string> = {
  connected: "Connected",
  trial: "Trial Mode",
  connecting: "Connecting…",
  disconnected: "Disconnected",
};

export function BrokerStatus() {
  const { status, broker, latency, error } = useFeed();
  const [open, setOpen] = useState(false);
  useTopic("clock", 1000);
  const src = market.source;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={error ?? "Broker / feed connection"}
        className="no-drag flex h-[22px] items-center gap-1.5 rounded-[3px] border border-line bg-panel2 px-2 text-[11px] hover:border-line2"
      >
        <StatusDot status={status} />
        <span className="font-semibold">{STATUS_LABEL[status]}</span>
        <span className="text-muted">
          {status === "connected" ? (src === "mock" ? "Mock server" : src === "dhan" ? "Dhan" : "Zerodha") : status === "trial" ? "in-browser sim" : broker}
        </span>
        {latency !== null && status === "connected" && <span className="num text-dim">{latency}ms</span>}
      </button>
      {open && <ConnectModal onClose={() => setOpen(false)} />}
    </>
  );
}

function ConnectModal({ onClose }: { onClose: () => void }) {
  const st = useFeed();
  const [mode, setMode] = useState<FeedMode>(st.mode);
  const [url, setUrl] = useState(st.url);
  const [broker, setBroker] = useState<BrokerName>(st.broker);
  return (
    <Modal title="Broker connection engine" onClose={onClose} width={520}>
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-[11px]">
          <StatusDot status={st.status} />
          <span className="font-semibold">{STATUS_LABEL[st.status]}</span>
          {st.error && <span className="text-warn">{st.error}</span>}
        </div>
        <Field label="Broker">
          <Seg<BrokerName>
            value={broker}
            onChange={setBroker}
            options={[
              { value: "Mock", label: "Mock market" },
              { value: "Dhan", label: "Dhan" },
              { value: "Zerodha", label: "Zerodha" },
            ]}
          />
        </Field>
        <Field label="Feed source">
          <Seg<FeedMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "auto", label: "Auto (server → trial)" },
              { value: "server", label: "Server only" },
              { value: "browser", label: "In-browser trial" },
            ]}
          />
        </Field>
        <Field label="Backend WebSocket URL" hint="Empty = this site's /feed endpoint (the built-in mock server). Point it at your Dhan / Zerodha backend that speaks the same protocol.">
          <TextInput value={url} placeholder="wss://your-backend.example.com/feed" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        {broker !== "Mock" && (
          <div className="rounded border border-line bg-panel2 p-2 text-[11px] leading-relaxed text-muted">
            Broker credentials never go to the browser. Run the terminal backend (see <span className="num text-fg">trading-terminal-backend</span> skill) with your {broker}{" "}
            {broker === "Dhan" ? "client ID + access token" : "Kite api_key + daily access token"} and a static IP, then enter its WebSocket URL above.
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Btn onClick={() => feed.disconnect()} danger>
            Disconnect
          </Btn>
          <Btn
            active
            onClick={() => {
              feed.configure({ mode, url: url.trim(), broker });
              onClose();
            }}
          >
            Connect
          </Btn>
        </div>
      </div>
    </Modal>
  );
}

export function SimClock() {
  useTopic("clock", 1000);
  const { status } = useFeed();
  if (status === "disconnected") return null;
  return (
    <span className="num hidden text-[11px] text-muted md:inline" title={`Market clock (IST)${market.speed !== 1 ? ` · ${market.speed}× speed` : ""}`}>
      {fmtDate(market.simTime)} {fmtTime(market.simTime, true)} IST{market.speed !== 1 ? ` ×${market.speed}` : ""}
    </span>
  );
}

export function WorkspaceMenu() {
  const { current, saved, saveAs, overwrite, load, deleteSaved, exportJson, importJson, reset } = useWorkspace();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const names = Object.keys(saved).sort();
  return (
    <>
      <Menu trigger={<>▦ {current}</>} title="Workspace manager" width={240}>
        {(close) => (
          <>
            <MenuLabel>Workspace</MenuLabel>
            <MenuItem
              onClick={() => {
                const n = prompt("Save workspace as:", current === "Default" ? "My Workspace" : `${current} copy`);
                if (n) saveAs(n);
                close();
              }}
            >
              Save as…
            </MenuItem>
            <MenuItem
              onClick={() => {
                overwrite();
                setMsg(`Saved “${current}”`);
                close();
              }}
            >
              Overwrite “{current}”
            </MenuItem>
            <MenuItem
              onClick={() => {
                const blob = new Blob([exportJson()], { type: "application/json" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `${current.replace(/[^\w-]+/g, "_")}.workspace.json`;
                a.click();
                URL.revokeObjectURL(a.href);
                close();
              }}
            >
              Export JSON
            </MenuItem>
            <MenuItem
              onClick={() => {
                fileRef.current?.click();
                close();
              }}
            >
              Import JSON…
            </MenuItem>
            <MenuItem
              onClick={() => {
                if (confirm("Reset the current layout to the default workspace?")) reset();
                close();
              }}
            >
              Reset to default
            </MenuItem>
            <MenuLabel>Saved ({names.length})</MenuLabel>
            {!names.length && <div className="px-2 py-1 text-[11px] text-dim">No saved workspaces</div>}
            {names.map((n) => (
              <div key={n} className="flex items-center">
                <div className="flex-1">
                  <MenuItem
                    active={n === current}
                    onClick={() => {
                      load(n);
                      close();
                    }}
                  >
                    {n}
                  </MenuItem>
                </div>
                <button
                  type="button"
                  title={`Delete ${n}`}
                  className="px-1.5 text-[11px] text-dim hover:text-down"
                  onClick={() => {
                    if (confirm(`Delete workspace “${n}”?`)) deleteSaved(n);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </>
        )}
      </Menu>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const err = importJson(await f.text());
          setMsg(err ?? `Imported ${f.name}`);
          e.target.value = "";
        }}
      />
      {msg && (
        <span className="flash rounded px-1 text-[10px] text-muted" onAnimationEnd={() => setTimeout(() => setMsg(null), 1200)}>
          {msg}
        </span>
      )}
    </>
  );
}

function PresetIcon({ p }: { p: Preset }) {
  return (
    <svg width="22" height="14" viewBox="0 0 12 12" className="shrink-0">
      {presetCells(p).map((c, i) => (
        <rect key={i} x={c.x + 0.4} y={c.y + 0.4} width={c.w - 0.8} height={c.h - 0.8} rx="0.6" fill="none" stroke="currentColor" strokeWidth="0.7" />
      ))}
    </svg>
  );
}

export function LayoutSelector({ screen }: { screen: Screen }) {
  const { applyPreset, ws } = useWorkspace();
  return (
    <div className="no-drag flex items-center gap-0.5" title="Layout presets">
      {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => (
        <button
          key={p}
          type="button"
          title={`${PRESET_LABELS[p]} — keeps current tiles in order, adds charts to fill, removes extras`}
          onClick={() => applyPreset(p, screen)}
          className={cx("flex h-[22px] items-center rounded-[3px] px-1 hover:bg-panel3", ws.preset === p && screen === 0 ? "text-[#9ec5ff]" : "text-muted")}
        >
          <PresetIcon p={p} />
        </button>
      ))}
    </div>
  );
}

export function AddWidgetMenu({ screen }: { screen: Screen }) {
  const addWidget = useWorkspace((s) => s.addWidget);
  const count = useWorkspace((s) => Object.values(s.ws.widgets).filter((w) => w.screen === screen && !w.float).length);
  return (
    <Menu trigger={<>＋ Widget</>} title="Add widget" width={200}>
      {(close) => (
        <>
          <MenuLabel>
            Tiles {count}/{MAX_TILES}
          </MenuLabel>
          {(Object.keys(WIDGET_LABELS) as WidgetType[]).map((t) => (
            <MenuItem
              key={t}
              disabled={count >= MAX_TILES}
              onClick={() => {
                addWidget(t, screen);
                close();
              }}
            >
              {WIDGET_LABELS[t]}
            </MenuItem>
          ))}
        </>
      )}
    </Menu>
  );
}

export function TimeControls() {
  const { ws, setTf, setRange } = useWorkspace();
  return (
    <div className="flex items-center gap-1.5">
      <Seg<TF>
        value={ws.tf}
        onChange={setTf}
        options={(["1m", "3m", "5m", "15m"] as TF[]).map((v) => ({ value: v, label: v, title: `Global timeframe ${v}` }))}
      />
      <Seg<Range>
        value={ws.range}
        onChange={setRange}
        options={(["1D", "5D", "15D"] as Range[]).map((v) => ({ value: v, label: v, title: `History range ${v}` }))}
      />
    </div>
  );
}

export function ScreensMenu() {
  const widgets = useWorkspace((s) => s.ws.widgets);
  const counts = [1, 2].map((s) => Object.values(widgets).filter((w) => w.screen === s).length);
  return (
    <Menu trigger={<>⧉ Screens</>} title="Multi-screen pop-out windows" width={230} align="right">
      {(close) => (
        <>
          <MenuLabel>Pop-out windows</MenuLabel>
          {([1, 2] as const).map((s) => (
            <MenuItem
              key={s}
              hint={`${counts[s - 1]} widget${counts[s - 1] === 1 ? "" : "s"}`}
              onClick={() => {
                openScreen(s);
                close();
              }}
            >
              Open Screen {s}
            </MenuItem>
          ))}
          <div className="px-2 py-1 text-[10px] leading-snug text-dim">Use a widget&apos;s ⧉ button to move it to Screen 1 or 2. Symbols, marks and crosshairs stay linked across windows.</div>
        </>
      )}
    </Menu>
  );
}

export function TopBar({ screen }: { screen: Screen }) {
  return (
    <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
      <div className="flex items-center gap-1.5 pr-1">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <rect x="1" y="6" width="3" height="8" fill="#22c55e" />
          <rect x="6" y="2" width="3" height="12" fill="#3b82f6" />
          <rect x="11" y="8" width="3" height="6" fill="#ef4444" />
        </svg>
        <span className="text-[12px] font-semibold tracking-wide">
          OrderFlow<span className="text-accent">Terminal</span>
        </span>
        {screen > 0 && <span className="rounded bg-accent/20 px-1.5 text-[10px] text-[#9ec5ff]">Screen {screen}</span>}
      </div>
      <BrokerStatus />
      {screen === 0 && <WorkspaceMenu />}
      <div className="mx-1 h-4 w-px bg-line" />
      <LayoutSelector screen={screen} />
      <AddWidgetMenu screen={screen} />
      <div className="mx-1 h-4 w-px bg-line" />
      <TimeControls />
      <div className="flex-1" />
      <SimClock />
      {screen === 0 && <ScreensMenu />}
    </div>
  );
}

export function TfSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Sel
      value={value}
      onChange={onChange}
      title="Timeframe (Global follows the toolbar)"
      options={[
        { value: "global", label: "TF: Global" },
        { value: "1m", label: "1m" },
        { value: "3m", label: "3m" },
        { value: "5m", label: "5m" },
        { value: "15m", label: "15m" },
      ]}
    />
  );
}
