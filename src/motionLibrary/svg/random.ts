/**
 * Seeded randomness for motion library generators. Pure 32-bit integer math
 * (Math.imul), so the sequence is identical on every engine. Generators never
 * call Math.random or read the clock.
 *
 * - seededRandom(itemId, seed, index) is stateless: one value per index.
 * - createSeededRng(itemId, seed, stream) is a stateful stream for sequential draws.
 */

/** xmur3-style string hash to a 32-bit unsigned integer. */
export function hashString32(text: string): number {
  let hash = 1779033703 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
  hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** mulberry32: a fast 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function assertSeedInputs(itemId: string, seed: number): void {
  if (typeof itemId !== "string" || !itemId) throw new Error("seeded random needs an item id");
  if (!Number.isInteger(seed)) throw new Error("seeded random needs an integer seed");
}

/** One reproducible value in [0, 1) for (item, seed, index). */
export function seededRandom(itemId: string, seed: number, index: number): number {
  assertSeedInputs(itemId, seed);
  if (!Number.isInteger(index)) throw new Error("seeded random index must be an integer");
  return mulberry32(hashString32(`${itemId}\u0000${seed}\u0000${index}`))();
}

// ---------------------------------------------------------------------------
// Smooth noise (lattice value noise, integer hashing): deterministic everywhere.
// ---------------------------------------------------------------------------

function latticeHash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27D4EB2D) ^ Math.imul(y | 0, 0x165667B1) ^ Math.imul(seed | 0, 0x9E3779B1);
  h = Math.imul(h ^ (h >>> 15), 0x85EBCA6B);
  h = Math.imul(h ^ (h >>> 13), 0xC2B2AE35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const quintic = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth 2D value noise in [-1, 1] (C2-continuous, lattice spacing 1). */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = quintic(x - x0), fy = quintic(y - y0);
  const a = latticeHash(x0, y0, seed), b = latticeHash(x0 + 1, y0, seed), c = latticeHash(x0, y0 + 1, seed), d = latticeHash(x0 + 1, y0 + 1, seed);
  const top = a + (b - a) * fx, bottom = c + (d - c) * fx;
  return (top + (bottom - top) * fy) * 2 - 1;
}

/** Smooth 1D value noise in [-1, 1]. */
export function valueNoise1D(x: number, seed: number): number {
  return valueNoise2D(x, 0.5, seed);
}

/** Sum of `octaves` noise layers (frequency × lacunarity, amplitude × gain), normalised to [-1, 1]. */
export function fractalNoise2D(x: number, y: number, seed: number, octaves = 3, lacunarity = 2, gain = 0.5): number {
  if (!Number.isInteger(octaves) || octaves < 1 || octaves > 8) throw new Error("fractalNoise2D octaves must be 1..8");
  let sum = 0, amplitude = 1, frequency = 1, norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum += amplitude * valueNoise2D(x * frequency, y * frequency, seed + octave * 7919);
    norm += amplitude; amplitude *= gain; frequency *= lacunarity;
  }
  return sum / norm;
}

/**
 * Noise that loops: sampled on a circle of `radius` lattice units, so
 * loopNoise(0) === loopNoise(1) exactly and the value is smooth in between.
 * `lane` picks an independent track (different circle centre).
 */
export function loopNoise(phase: number, seed: number, radius = 1, lane = 0): number {
  const angle = 2 * Math.PI * (phase - Math.floor(phase));
  return valueNoise2D(lane * 17.31 + radius * Math.cos(angle), lane * 5.17 + radius * Math.sin(angle), seed);
}

export interface SeededRng {
  /** Float in [0, 1). */
  next(): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** -1 or 1. */
  sign(): -1 | 1;
  chance(probability: number): boolean;
  /** Approximately normal (mean 0, sd 1), from 4 uniforms (Irwin–Hall), fully deterministic. */
  normal(): number;
  /** Independent child stream (does not advance this stream). */
  fork(label: string | number): SeededRng;
}

export function createSeededRng(itemId: string, seed: number, stream: string | number = 0): SeededRng {
  assertSeedInputs(itemId, seed);
  const key = `${itemId}\u0000${seed}\u0000stream:${String(stream)}`;
  const next = mulberry32(hashString32(key));
  const rng: SeededRng = {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => {
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) throw new Error("rng.int needs integer bounds with max >= min");
      return min + Math.floor(next() * (max - min + 1));
    },
    pick: items => {
      if (!items.length) throw new Error("rng.pick needs a non-empty list");
      return items[Math.floor(next() * items.length)];
    },
    sign: () => (next() < 0.5 ? -1 : 1),
    chance: probability => next() < probability,
    normal: () => (next() + next() + next() + next() - 2) * Math.sqrt(3),
    fork: label => createSeededRng(itemId, seed, `${String(stream)}/${String(label)}`),
  };
  return Object.freeze(rng);
}
