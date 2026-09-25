"use client";
import { useEffect, useReducer, useRef } from "react";
import type { Sub } from "./protocol";
import { subKey } from "./protocol";
import { feed } from "./client";
import { market } from "./store";

/** Re-render when a store topic changes, at most once per `throttleMs` (0 = every frame). */
export function useTopic(topic: string | null, throttleMs = 0): number {
  const [, force] = useReducer((x: number) => x + 1, 0);
  const last = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!topic) return;
    const off = market.subscribe(topic, () => {
      if (!throttleMs) return force();
      const now = performance.now();
      const wait = throttleMs - (now - last.current);
      if (wait <= 0) {
        last.current = now;
        force();
      } else if (!timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null;
          last.current = performance.now();
          force();
        }, wait);
      }
    });
    return () => {
      off();
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [topic, throttleMs]);
  return topic ? market.version(topic) : 0;
}

/** Keep a feed subscription alive while the component is mounted. */
export function useSub(sub: Sub | null): void {
  const key = sub ? subKey(sub) : null;
  const ref = useRef(sub);
  ref.current = sub;
  useEffect(() => {
    if (!key || !ref.current) return;
    return feed.subscribe(ref.current);
  }, [key]);
}

export function useSubs(subs: Sub[]): void {
  const keys = subs.map(subKey).join("|");
  const ref = useRef(subs);
  ref.current = subs;
  useEffect(() => {
    const offs = ref.current.map((s) => feed.subscribe(s));
    return () => offs.forEach((f) => f());
  }, [keys]);
}
