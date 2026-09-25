"use client";
/**
 * Feed connection engine. Tries the configured WebSocket backend first (the mock
 * server at /feed, or a real Dhan/Zerodha backend speaking the same protocol);
 * falls back to the in-browser simulator ("Trial Mode") when it is unreachable.
 */
import { create } from "zustand";
import type { ClientMsg, ServerMsg, Sub } from "./protocol";
import { subKey } from "./protocol";
import { market } from "./store";

export type FeedMode = "auto" | "server" | "browser";
export type FeedStatus = "connecting" | "connected" | "trial" | "disconnected";
export type BrokerName = "Mock" | "Dhan" | "Zerodha";

interface FeedState {
  status: FeedStatus;
  mode: FeedMode;
  url: string;
  broker: BrokerName;
  latency: number | null;
  error: string | null;
  set: (p: Partial<FeedState>) => void;
}

const SETTINGS_KEY = "odx.feed.v1";

function loadSettings(): Partial<FeedState> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

export const useFeed = create<FeedState>((set) => ({
  status: "connecting",
  mode: "auto",
  url: "",
  broker: "Mock",
  latency: null,
  error: null,
  set: (p) => set(p),
}));

interface Port {
  send(msg: ClientMsg): void;
  close(): void;
}

class FeedClient {
  private port: Port | null = null;
  private subs = new Map<string, { sub: Sub; refs: number }>();
  private started = false;
  private retries = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;

  start(): void {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    const s = loadSettings();
    useFeed.setState({ mode: s.mode ?? "auto", url: s.url ?? "", broker: s.broker ?? "Mock" });
    window.addEventListener("beforeunload", () => this.port?.close());
    this.connect();
  }

  /** Change connection settings and reconnect. */
  configure(p: { mode?: FeedMode; url?: string; broker?: BrokerName }): void {
    const cur = useFeed.getState();
    const next = { mode: p.mode ?? cur.mode, url: p.url ?? cur.url, broker: p.broker ?? cur.broker };
    useFeed.setState(next);
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
    this.retries = 0;
    this.connect();
  }

  disconnect(): void {
    this.generation++;
    this.port?.close();
    this.port = null;
    useFeed.setState({ status: "disconnected", latency: null });
  }

  private feedUrl(): string {
    const { url } = useFeed.getState();
    if (url) return url;
    const env = process.env.NEXT_PUBLIC_FEED_URL;
    if (env) return env;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/feed`;
  }

  private speedParam(): number | undefined {
    const v = Number(new URLSearchParams(location.search).get("speed"));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  }

  private connect(): void {
    const gen = ++this.generation;
    this.port?.close();
    this.port = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    const { mode } = useFeed.getState();
    useFeed.setState({ status: "connecting", error: null });
    if (mode === "browser") return this.startBrowser(gen);
    this.startSocket(gen, mode === "auto");
  }

  private onMessage(msg: ServerMsg): void {
    if (msg.t === "pong") {
      useFeed.setState({ latency: Math.round(performance.now() - msg.ts) });
      return;
    }
    if (msg.t === "error") {
      console.warn("[feed]", msg.message);
      return;
    }
    market.apply(msg);
  }

  private afterOpen(port: Port, status: FeedStatus): void {
    this.port = port;
    this.retries = 0;
    useFeed.setState({ status });
    port.send({ op: "hello", speed: this.speedParam() });
    for (const [key, { sub }] of this.subs) port.send({ op: "sub", key, sub });
    this.pingTimer = setInterval(() => port.send({ op: "ping", ts: performance.now() }), 5000);
  }

  private startSocket(gen: number, fallback: boolean): void {
    let opened = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.feedUrl());
    } catch (e) {
      useFeed.setState({ error: String(e) });
      if (fallback) this.startBrowser(gen);
      else useFeed.setState({ status: "disconnected" });
      return;
    }
    const timeout = setTimeout(() => {
      if (!opened) ws.close();
    }, 2500);
    const port: Port = {
      send: (m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)),
      close: () => ws.close(),
    };
    ws.onopen = () => {
      if (gen !== this.generation) return ws.close();
      opened = true;
      clearTimeout(timeout);
      this.afterOpen(port, "connected");
    };
    ws.onmessage = (e) => {
      if (gen !== this.generation) return;
      try {
        this.onMessage(JSON.parse(e.data as string) as ServerMsg);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      if (gen !== this.generation) return;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.port = null;
      if (!opened && fallback) {
        useFeed.setState({ error: "Feed server unreachable — running the in-browser simulator" });
        this.startBrowser(gen);
        return;
      }
      useFeed.setState({ status: "disconnected", latency: null });
      const delay = Math.min(15000, 1000 * 2 ** this.retries++);
      setTimeout(() => {
        if (gen === this.generation) this.connect();
      }, delay);
    };
  }

  private startBrowser(gen: number): void {
    if (gen !== this.generation) return;
    let raw: MessagePort | Worker;
    try {
      if (typeof SharedWorker !== "undefined") {
        const w = new SharedWorker(new URL("./sim.worker.ts", import.meta.url), { name: "odx-sim", type: "module" });
        w.port.start();
        raw = w.port;
      } else {
        raw = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
      }
    } catch (e) {
      useFeed.setState({ status: "disconnected", error: `Simulator failed to start: ${String(e)}` });
      return;
    }
    raw.onmessage = (e: MessageEvent<ServerMsg>) => {
      if (gen === this.generation) this.onMessage(e.data);
    };
    const port: Port = {
      send: (m) => raw.postMessage(m),
      close: () => {
        raw.postMessage({ op: "bye" });
        if ("terminate" in raw) raw.terminate();
        else raw.close();
      },
    };
    this.afterOpen(port, "trial");
  }

  subscribe(sub: Sub): () => void {
    const key = subKey(sub);
    const cur = this.subs.get(key);
    if (cur) cur.refs++;
    else {
      this.subs.set(key, { sub, refs: 1 });
      this.port?.send({ op: "sub", key, sub });
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const e = this.subs.get(key);
      if (!e) return;
      if (--e.refs <= 0) {
        this.subs.delete(key);
        this.port?.send({ op: "unsub", key });
      }
    };
  }
}

export const feed = new FeedClient();
