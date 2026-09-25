"use client";
import dynamic from "next/dynamic";

// The terminal is client-only: it reads workspace state from localStorage and
// runs canvas renderers, so it is never server-rendered.
const Terminal = dynamic(() => import("./Terminal"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-muted">
      <span className="num">Loading terminal…</span>
    </div>
  ),
});

export default function ClientTerminal({ screen }: { screen: 0 | 1 | 2 }) {
  return <Terminal screen={screen} />;
}
