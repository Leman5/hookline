import { FRAME, HOP, type Features } from './features.ts';

export interface BeatFeatures {
  /** Number of beats. */
  count: number;
  /** Beat start times in seconds, length count + 1 (last = end of audio). */
  times: Float64Array;
  loudDb: Float32Array;
  /** Loudness as a within-track percentile, 0..1. */
  loudPct: Float32Array;
  onsetPct: Float32Array;
  /** Mean-centered, L2-normalized chroma per beat (count x 12). */
  chroma: Float32Array;
  /** How strongly this beat belongs to a repeated section, 0..1. */
  rep: Float32Array;
  /** Section-boundary strength, 0..1. */
  novelty: Float32Array;
}

const STACK = 4; // beats stacked per similarity vector (one bar)
const MIN_LAG = 16; // beats: ignore self-similarity closer than 4 bars
const SMOOTH = 8; // beats: radius of diagonal smoothing
const KERNEL = 8; // beats: half-size of the novelty checkerboard

export function beatFeatures(f: Features, beatFrames: number[], duration: number): BeatFeatures {
  const count = beatFrames.length;
  const times = new Float64Array(count + 1);
  // Frame t covers samples [t*HOP, t*HOP+FRAME): report the window centre.
  const centre = FRAME / 2 / (f.fps * HOP);
  for (let i = 0; i < count; i++) times[i] = beatFrames[i] / f.fps + centre;
  times[count] = duration;
  const loudDb = new Float32Array(count);
  const onset = new Float32Array(count);
  const chroma = new Float32Array(count * 12);
  for (let i = 0; i < count; i++) {
    const a = Math.max(0, Math.round(beatFrames[i]));
    const b = Math.min(f.frames, Math.max(a + 1, Math.round(i + 1 < count ? beatFrames[i + 1] : f.frames)));
    let lsum = 0, osum = 0;
    for (let t = a; t < b; t++) {
      lsum += f.loud[t];
      osum += f.onset[t];
      for (let k = 0; k < 12; k++) chroma[i * 12 + k] += f.chroma[t * 12 + k];
    }
    const n = Math.max(1, b - a);
    loudDb[i] = lsum / n;
    onset[i] = osum / n;
    for (let k = 0; k < 12; k++) chroma[i * 12 + k] /= n;
  }
  // Mean-center each pitch class over the song, then normalize per beat.
  for (let k = 0; k < 12; k++) {
    let m = 0;
    for (let i = 0; i < count; i++) m += chroma[i * 12 + k];
    m /= count || 1;
    for (let i = 0; i < count; i++) chroma[i * 12 + k] -= m;
  }
  for (let i = 0; i < count; i++) normalize(chroma, i * 12, 12);

  const ssm = similarity(chroma, count);
  return {
    count,
    times,
    loudDb,
    loudPct: percentiles(loudDb),
    onsetPct: percentiles(onset),
    chroma,
    rep: repetition(ssm, count),
    novelty: novelty(ssm, count),
  };
}

function normalize(v: Float32Array, off: number, len: number): void {
  let s = 0;
  for (let k = 0; k < len; k++) s += v[off + k] * v[off + k];
  const n = Math.sqrt(s);
  if (n > 1e-9) for (let k = 0; k < len; k++) v[off + k] /= n;
}

/** Cosine similarity between bar-length stacks of beat chroma. */
function similarity(chroma: Float32Array, count: number): Float32Array {
  const dim = 12 * STACK;
  const vec = new Float32Array(count * dim);
  for (let i = 0; i < count; i++) {
    for (let s = 0; s < STACK; s++) {
      const src = Math.min(count - 1, i + s);
      vec.set(chroma.subarray(src * 12, src * 12 + 12), i * dim + s * 12);
    }
    normalize(vec, i * dim, dim);
  }
  const ssm = new Float32Array(count * count);
  for (let i = 0; i < count; i++) {
    ssm[i * count + i] = 1;
    for (let j = i + 1; j < count; j++) {
      let d = 0;
      for (let k = 0; k < dim; k++) d += vec[i * dim + k] * vec[j * dim + k];
      ssm[i * count + j] = d;
      ssm[j * count + i] = d;
    }
  }
  return ssm;
}

/** Strength of the best repetition of each beat at any lag of at least MIN_LAG beats. */
function repetition(ssm: Float32Array, count: number): Float32Array {
  const rep = new Float32Array(count).fill(-1);
  const diag = new Float32Array(count);
  const pre = new Float64Array(count + 1);
  for (let lag = MIN_LAG; lag < count; lag++) {
    const n = count - lag;
    for (let i = 0; i < n; i++) diag[i] = ssm[i * count + i + lag];
    pre[0] = 0;
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + diag[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - SMOOTH), b = Math.min(n, i + SMOOTH + 1);
      const v = (pre[b] - pre[a]) / (b - a);
      if (v > rep[i]) rep[i] = v;
      if (v > rep[i + lag]) rep[i + lag] = v;
    }
  }
  return rescale(rep, true);
}

/** Foote checkerboard novelty along the SSM diagonal. */
function novelty(ssm: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count);
  const sigma = KERNEL / 2;
  for (let i = KERNEL; i < count - KERNEL; i++) {
    let s = 0;
    for (let a = -KERNEL; a < KERNEL; a++) {
      for (let b = -KERNEL; b < KERNEL; b++) {
        const sign = (a < 0) === (b < 0) ? 1 : -1;
        const g = Math.exp(-((a + 0.5) ** 2 + (b + 0.5) ** 2) / (2 * sigma * sigma));
        s += sign * g * ssm[(i + a) * count + (i + b)];
      }
    }
    out[i] = Math.max(0, s);
  }
  return rescale(out, false);
}

/** Map to 0..1 between the median (or min) and the max. */
function rescale(x: Float32Array, fromMedian: boolean): Float32Array {
  const sorted = Array.from(x).sort((a, b) => a - b);
  const lo = fromMedian ? sorted[Math.floor(sorted.length / 2)] ?? 0 : sorted[0] ?? 0;
  const hi = sorted[sorted.length - 1] ?? 1;
  const out = new Float32Array(x.length);
  const span = hi - lo;
  for (let i = 0; i < x.length; i++) out[i] = span > 1e-9 ? Math.min(1, Math.max(0, (x[i] - lo) / span)) : 0;
  return out;
}

/** Rank of each value within the array, 0..1. */
export function percentiles(x: Float32Array): Float32Array {
  const idx = Array.from(x.keys()).sort((a, b) => x[a] - x[b]);
  const out = new Float32Array(x.length);
  const n = Math.max(1, x.length - 1);
  idx.forEach((i, r) => (out[i] = r / n));
  return out;
}
