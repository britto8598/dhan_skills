/** Small deterministic RNG helpers shared by the simulator (browser worker and Node server). */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string plus optional numbers; stable seeds per (symbol, minute, ...). */
export function hash32(s: string, ...nums: number[]): number {
  let h = 0x811c9dc5;
  const str = nums.length ? `${s}|${nums.join("|")}` : s;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function gauss(rng: Rng): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Exponential with the given mean. */
export function expo(rng: Rng, mean: number): number {
  return -Math.log(1 - rng()) * mean;
}
