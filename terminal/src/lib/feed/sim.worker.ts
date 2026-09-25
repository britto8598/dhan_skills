/// <reference lib="webworker" />
/**
 * In-browser market simulator ("Trial Mode"). Loaded as a SharedWorker so the main
 * window and pop-out screens share one simulated market; falls back to a dedicated
 * Worker where SharedWorker is unavailable.
 */
import type { ClientMsg, ServerMsg } from "./protocol";
import { SimHost } from "../sim/host";

let host: SimHost | null = null;
let seq = 0;

function getHost(): SimHost {
  if (!host) {
    host = new SimHost();
    host.start(250);
  }
  return host;
}

function attach(port: MessagePort | DedicatedWorkerGlobalScope): void {
  const id = `c${++seq}`;
  const h = getHost();
  h.addClient(id, (msg: ServerMsg) => port.postMessage(msg));
  port.onmessage = (e: MessageEvent<ClientMsg | { op: "bye" }>) => {
    if (e.data.op === "bye") h.removeClient(id);
    else h.handle(id, e.data);
  };
}

const scope = self as unknown as { onconnect?: unknown };
if ("onconnect" in scope || typeof (self as unknown as { SharedWorkerGlobalScope?: unknown }).SharedWorkerGlobalScope !== "undefined") {
  (self as unknown as { onconnect: (e: MessageEvent) => void }).onconnect = (e: MessageEvent) => {
    const port = e.ports[0];
    attach(port);
    port.start();
  };
} else {
  attach(self as unknown as DedicatedWorkerGlobalScope);
}
