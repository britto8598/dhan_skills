/**
 * Custom Next.js server: serves the terminal UI and the mock market-data
 * WebSocket feed on the same port (default http://localhost:3000, ws://…/feed).
 *
 *   npm run dev     → Next dev mode + mock feed (hot reload)
 *   npm start       → production (after `npm run build`)
 *
 * Env: PORT (3000), HOST (0.0.0.0), SIM_SPEED (1), FEED_PATH (/feed).
 */
import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg } from "../src/lib/feed/protocol";
import { MarketSim } from "../src/lib/sim/market";
import { SimHost } from "../src/lib/sim/host";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";
const feedPath = process.env.FEED_PATH || "/feed";

async function main(): Promise<void> {
  const app = next({ dev, hostname, port, webpack: true });
  const handle = app.getRequestHandler();
  await app.prepare();
  const upgradeNext = app.getUpgradeHandler();

  const host = new SimHost(new MarketSim({ speed: Number(process.env.SIM_SPEED || 1) }));
  host.start(250);

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 4096 } });
  let seq = 0;
  wss.on("connection", (ws: WebSocket) => {
    const id = `ws${++seq}`;
    let alive = true;
    host.addClient(id, (msg) => {
      if (ws.readyState === ws.OPEN && ws.bufferedAmount < 8 * 1024 * 1024) ws.send(JSON.stringify(msg));
    });
    ws.on("message", (raw) => {
      try {
        host.handle(id, JSON.parse(String(raw)) as ClientMsg);
      } catch {
        /* ignore malformed frames */
      }
    });
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20000);
    ws.on("close", () => {
      clearInterval(ping);
      host.removeClient(id);
    });
  });

  const server = createServer((req, res) => {
    const url = parse(req.url || "/", true);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, simTime: host.sim.simTime, speed: host.sim.speed }));
      return;
    }
    handle(req, res, url);
  });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url || "/");
    if (pathname === feedPath) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      upgradeNext(req, socket, head);
    }
  });

  server.listen(port, hostname, () => {
    console.log(`> Terminal ready on http://localhost:${port}  (feed ws://localhost:${port}${feedPath}, ${dev ? "dev" : "production"})`);
  });

  const shutdown = () => {
    host.stop();
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
