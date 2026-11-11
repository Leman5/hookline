import { fft, hann } from './fft.ts';

export const FRAME = 1024;
export const HOP = 256;

export interface Features {
  fps: number;
  frames: number;
  /** Frame loudness in dBFS. */
  loud: Float32Array;
  /** Half-wave-rectified log spectral flux (onset strength). */
  onset: Float32Array;
  /** Low-band (< 150 Hz) flux, used to find downbeats. */
  lowFlux: Float32Array;
  /** Spectral centroid in Hz. */
  centroid: Float32Array;
  /** 12 pitch-class values per frame, row-major (frames x 12). */
  chroma: Float32Array;
}

/** Frame-level features of mono PCM. */
export function extractFeatures(pcm: Float32Array, sampleRate: number): Features {
  const frames = Math.max(0, Math.floor((pcm.length - FRAME) / HOP) + 1);
  const fps = sampleRate / HOP;
  const loud = new Float32Array(frames);
  const onset = new Float32Array(frames);
  const lowFlux = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const chroma = new Float32Array(frames * 12);
  const win = hann(FRAME);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const bins = FRAME / 2 + 1;
  const prev = new Float32Array(bins);
  const cur = new Float32Array(bins);
  const binHz = sampleRate / FRAME;
  const lowBin = Math.max(1, Math.round(150 / binHz));
  // Pitch class per bin for 110 Hz .. 3 kHz, -1 elsewhere.
  const pc = new Int8Array(bins).fill(-1);
  for (let k = 1; k < bins; k++) {
    const f = k * binHz;
    if (f >= 110 && f <= 3000) pc[k] = ((Math.round(12 * Math.log2(f / 440)) + 69) % 12 + 12) % 12;
  }

  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    let energy = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = pcm[off + i];
      energy += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    loud[t] = 10 * Math.log10(energy / FRAME + 1e-10);
    fft(re, im);
    let flux = 0, low = 0, num = 0, den = 0;
    for (let k = 0; k < bins; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const lm = Math.log1p(100 * mag);
      cur[k] = lm;
      const d = lm - prev[k];
      if (d > 0) {
        flux += d;
        if (k <= lowBin) low += d;
      }
      num += k * binHz * mag;
      den += mag;
      if (pc[k] >= 0) chroma[t * 12 + pc[k]] += lm;
    }
    onset[t] = t === 0 ? 0 : flux;
    lowFlux[t] = t === 0 ? 0 : low;
    centroid[t] = den > 0 ? num / den : 0;
    prev.set(cur);
  }

  // Remove the slowly varying part of the flux so only onsets remain.
  const half = Math.round(0.25 * fps);
  const smooth = movingAverage(onset, half);
  for (let t = 0; t < frames; t++) onset[t] = Math.max(0, onset[t] - smooth[t]);
  return { fps, frames, loud, onset, lowFlux, centroid, chroma };
}

/** Centered moving average with radius r. */
export function movingAverage(x: Float32Array, r: number): Float32Array {
  const n = x.length;
  const out = new Float32Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - r), b = Math.min(n, i + r + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
}
