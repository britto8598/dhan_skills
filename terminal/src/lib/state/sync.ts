"use client";
/**
 * Multi-window engine: mirrors the workspace (symbol channels, widgets, layouts,
 * drawings, marks) and chart events (crosshair) across the main window and the
 * pop-out screens using the BroadcastChannel API.
 */
import { useWorkspace, type Workspace } from "./workspace";

export const WINDOW_ID = Math.random().toString(36).slice(2);
const CHANNEL = "odx-terminal-sync";

type SyncMsg =
  | { kind: "ws"; from: string; ws: Workspace }
  | { kind: "hello"; from: string; screen: number }
  | { kind: "event"; from: string; name: string; data: unknown }
  | { kind: "screens"; from: string; screens: number[] };

type EventHandler = (data: unknown, remote: boolean) => void;

let bc: BroadcastChannel | null = null;
let applyingRemote = false;
let pending: ReturnType<typeof setTimeout> | null = null;
const handlers = new Map<string, Set<EventHandler>>();
const openScreens = new Map<number, number>(); // screen -> last seen

function post(msg: SyncMsg): void {
  try {
    bc?.postMessage(msg);
  } catch {
    /* structured clone failure — ignore */
  }
}

export function startSync(screen: number): void {
  if (bc || typeof BroadcastChannel === "undefined") return;
  bc = new BroadcastChannel(CHANNEL);
  bc.onmessage = (e: MessageEvent<SyncMsg>) => {
    const m = e.data;
    if (!m || m.from === WINDOW_ID) return;
    if (m.kind === "ws") {
      applyingRemote = true;
      useWorkspace.getState().replaceWs(m.ws);
      applyingRemote = false;
    } else if (m.kind === "hello") {
      openScreens.set(m.screen, Date.now());
      // answer a new window with the authoritative workspace
      if (screen === 0) post({ kind: "ws", from: WINDOW_ID, ws: useWorkspace.getState().ws });
      emitLocal("screens", null);
    } else if (m.kind === "event") {
      handlers.get(m.name)?.forEach((h) => h(m.data, true));
    }
  };
  useWorkspace.subscribe((s, prev) => {
    if (applyingRemote || s.ws === prev.ws) return;
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      post({ kind: "ws", from: WINDOW_ID, ws: useWorkspace.getState().ws });
    }, 40);
  });
  post({ kind: "hello", from: WINDOW_ID, screen });
  setInterval(() => post({ kind: "hello", from: WINDOW_ID, screen }), 5000);
}

function emitLocal(name: string, data: unknown): void {
  handlers.get(name)?.forEach((h) => h(data, false));
}

/** Emit a chart event to this window and all other windows. */
export function emit(name: string, data: unknown): void {
  emitLocal(name, data);
  post({ kind: "event", from: WINDOW_ID, name, data });
}

export function on(name: string, h: EventHandler): () => void {
  let s = handlers.get(name);
  if (!s) handlers.set(name, (s = new Set()));
  s.add(h);
  return () => s!.delete(h);
}

/** Screens (1, 2) that announced themselves in the last 12 s. */
export function liveScreens(): number[] {
  const now = Date.now();
  return [...openScreens.entries()].filter(([, t]) => now - t < 12000).map(([s]) => s);
}

const popups = new Map<number, Window | null>();

export function openScreen(screen: 1 | 2): void {
  const url = new URL("/popout", location.href);
  url.searchParams.set("screen", String(screen));
  const speed = new URLSearchParams(location.search).get("speed");
  if (speed) url.searchParams.set("speed", speed);
  const existing = popups.get(screen);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }
  popups.set(screen, window.open(url.toString(), `odx-screen-${screen}`, "popup=yes,width=1400,height=860"));
}
