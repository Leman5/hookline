import type { Features } from './features.ts';

export interface Tempo {
  bpm: number;
  confidence: number;
  confident: boolean;
  /** Beat times in frames (fractional). */
  beats: number[];
  /** Index into beats of the first downbeat. */
  downbeat: number;
}

const MIN_BPM = 60;
const MAX_BPM = 200;
export const CONFIDENCE_THRESHOLD = 0.12;

function autocorr(o: Float32Array, maxLag: number): Float64Array {
  const n = o.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += o[i];
  mean /= n || 1;
  const a = new Float64Array(maxLag + 1);
  for (let l = 0; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += (o[i] - mean) * (o[i + l] - mean);
    a[l] = s / (n - l);
  }
  return a;
}

/** Interpolated autocorrelation at a fractional lag. */
const at = (a: Float64Array, l: number) => {
  const i = Math.floor(l);
  if (i + 1 >= a.length) return 0;
  const f = l - i;
  return a[i] * (1 - f) + a[i + 1] * f;
};

export function estimateTempo(f: Features): Tempo {
  const { fps, onset, lowFlux, frames } = f;
  const minLag = (60 * fps) / MAX_BPM;
  const maxLag = (60 * fps) / MIN_BPM;
  // Light smoothing widens sharp onset peaks so fractional lags interpolate well.
  const smooth = new Float32Array(frames);
  for (let i = 0; i < frames; i++) smooth[i] = 0.25 * (onset[i - 1] ?? 0) + 0.5 * onset[i] + 0.25 * (onset[i + 1] ?? 0);
  const a = autocorr(smooth, Math.min(frames - 1, Math.ceil(maxLag * 4) + 2));
  const a0 = a[0] || 1;

  let period = 0, best = -Infinity;
  for (let l = minLag; l <= maxLag; l += 0.25) {
    const bpm = (60 * fps) / l;
    const prior = Math.exp(-0.5 * Math.log2(bpm / 120) ** 2);
    const s = (Math.max(0, at(a, l)) + 0.5 * Math.max(0, at(a, 2 * l)) + 0.25 * Math.max(0, at(a, 4 * l))) * prior;
    if (s > best) { best = s; period = l; }
  }
  period = refinePeriod(onset, period);
  // Normalized autocorrelation at the beat period: near 0 for noise, high for a steady pulse.
  const confidence = Math.max(0, at(a, period)) / a0;
  const confident = confidence >= CONFIDENCE_THRESHOLD && best > 0;

  if (!confident || !(period > 0)) {
    // Plain 0.5 s grid: segments still work, just without beat snapping.
    const step = 0.5 * fps;
    const beats: number[] = [];
    for (let t = 0; t < frames; t += step) beats.push(t);
    return { bpm: 0, confidence, confident: false, beats, downbeat: 0 };
  }

  // Beat phase: offset maximizing a comb over onsets plus low-band (kick/bass) flux,
  // so beats land on the kick rather than on off-beat hi-hats.
  let om = 0, lm = 0;
  for (let i = 0; i < frames; i++) { om += onset[i]; lm += lowFlux[i]; }
  om = om / frames || 1;
  lm = lm / frames || 1;
  const pulse = new Float32Array(frames);
  for (let i = 0; i < frames; i++) pulse[i] = onset[i] / om + lowFlux[i] / lm;
  let bestPhase = 0, bestPhaseScore = -Infinity;
  for (let ph = 0; ph < period; ph += 0.5) {
    let s = 0;
    for (let t = ph; t < frames; t += period) s += pulse[Math.round(t)] ?? 0;
    if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = ph; }
  }
  const beats: number[] = [];
  for (let t = bestPhase; t < frames; t += period) {
    // Nudge to the local pulse maximum within +-2 frames to absorb drift.
    let bt = t, bv = -1;
    for (let d = -2; d <= 2; d++) {
      const v = pulse[Math.round(t) + d] ?? -1;
      if (v > bv) { bv = v; bt = Math.round(t) + d; }
    }
    beats.push(bv > 0 ? bt : t);
  }
  // Downbeat: the beat phase (of 4) carrying the most low-band energy.
  let downbeat = 0, bestLow = -Infinity;
  for (let j = 0; j < 4; j++) {
    let s = 0;
    for (let k = j; k < beats.length; k += 4) s += lowFlux[Math.round(beats[k])] ?? 0;
    if (s > bestLow) { bestLow = s; downbeat = j; }
  }
  return { bpm: (60 * fps) / period, confidence, confident: true, beats, downbeat };
}

/** Small search around a period that maximizes onset energy on a comb, to sharpen the BPM. */
function refinePeriod(onset: Float32Array, p: number): number {
  let best = p, bestScore = -Infinity;
  for (let q = p * 0.97; q <= p * 1.03; q += p * 0.0025) {
    let top = 0;
    for (let ph = 0; ph < q; ph += 1) {
      let s = 0, n = 0;
      for (let t = ph; t < onset.length; t += q) { s += onset[Math.round(t)] ?? 0; n++; }
      if (n && s / n > top) top = s / n;
    }
    if (top > bestScore) { bestScore = top; best = q; }
  }
  return best;
}

/** Fold BPM into 80..160 so half/double-time songs compare fairly. */
export function foldBpm(bpm: number): number {
  if (!(bpm > 0)) return 0;
  let b = bpm;
  while (b < 80) b *= 2;
  while (b > 160) b /= 2;
  return b;
}
