import { LISTS, PROFILES, type Analysis, type Segment } from '../types.ts';
import { extractFeatures, type Features } from './features.ts';
import { chooseSegments } from './segments.ts';
import { beatFeatures } from './structure.ts';
import { estimateTempo, foldBpm } from './tempo.ts';

/** Bump when the algorithm changes so cached results are recomputed. */
export const ANALYSIS_VERSION = 1;
/** Longer files are played whole: the similarity matrix would be too big for a phone. */
export const MAX_ANALYZED_SECONDS = 12 * 60;

export function analyze(pcm: Float32Array, sampleRate: number): Analysis {
  const duration = pcm.length / sampleRate;
  const whole = (): Record<'commute' | 'gym', Segment[]> => ({ commute: [{ start: 0, end: duration }], gym: [{ start: 0, end: duration }] });
  if (duration < 5) {
    return { version: ANALYSIS_VERSION, duration, bpm: 0, bpmConfidence: 0, confident: false, energy: 5, heat: [], bars: [], segments: whole() };
  }
  const f = extractFeatures(pcm, sampleRate);
  const heat = heatStrip(f, duration);
  if (duration > MAX_ANALYZED_SECONDS) {
    return { version: ANALYSIS_VERSION, duration, bpm: 0, bpmConfidence: 0, confident: false, energy: energyScore(f, 0), heat, bars: [], segments: whole() };
  }
  const tempo = estimateTempo(f);
  const bf = beatFeatures(f, tempo.beats, duration);
  const segments = {} as Record<'commute' | 'gym', Segment[]>;
  for (const l of LISTS) segments[l] = chooseSegments(bf, tempo.downbeat, PROFILES[l], duration);
  const bars: number[] = [];
  for (let i = tempo.downbeat; i < bf.count; i += 4) bars.push(Math.round(bf.times[i] * 100) / 100);
  return {
    version: ANALYSIS_VERSION,
    duration,
    bpm: Math.round(tempo.bpm * 10) / 10,
    bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    confident: tempo.confident,
    energy: energyScore(f, tempo.bpm),
    heat,
    bars,
    segments,
  };
}

/** Mean loudness per second mapped to 0..100 between the 5th and 99th percentile. */
function heatStrip(f: Features, duration: number): number[] {
  const secs = Math.ceil(duration);
  const raw = new Float32Array(secs);
  const per = f.fps;
  for (let s = 0; s < secs; s++) {
    const a = Math.floor(s * per), b = Math.min(f.frames, Math.floor((s + 1) * per));
    let sum = 0;
    for (let t = a; t < b; t++) sum += f.loud[t];
    raw[s] = b > a ? sum / (b - a) : -100;
  }
  const sorted = Array.from(raw).sort((x, y) => x - y);
  const lo = sorted[Math.floor(0.05 * (secs - 1))];
  const hi = sorted[Math.floor(0.99 * (secs - 1))];
  return Array.from(raw, (v) => Math.round(100 * Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1)))));
}

/** 1..10 energy from loudness, onset rate, brightness and tempo (reference constants for mastered music). */
export function energyScore(f: Features, bpm: number): number {
  const voiced: number[] = [];
  let centroidSum = 0, onsetMean = 0;
  for (let t = 0; t < f.frames; t++) {
    onsetMean += f.onset[t];
    if (f.loud[t] > -60) {
      voiced.push(f.loud[t]);
      centroidSum += f.centroid[t];
    }
  }
  if (!voiced.length) return 1;
  onsetMean /= f.frames;
  let sd = 0;
  for (let t = 0; t < f.frames; t++) sd += (f.onset[t] - onsetMean) ** 2;
  sd = Math.sqrt(sd / f.frames);
  let peaks = 0;
  for (let t = 1; t < f.frames - 1; t++) {
    const o = f.onset[t];
    if (o > onsetMean + sd && o >= f.onset[t - 1] && o > f.onset[t + 1]) peaks++;
  }
  voiced.sort((a, b) => a - b);
  const p95 = voiced[Math.floor(0.95 * (voiced.length - 1))];
  const onsetRate = peaks / (f.frames / f.fps);
  const centroid = centroidSum / voiced.length;
  const bpmEff = foldBpm(bpm) || 110;
  const z =
    0.4 * ((p95 + 13) / 4) +
    0.3 * ((onsetRate - 3.5) / 1.5) +
    0.2 * ((centroid - 1500) / 500) +
    0.1 * ((bpmEff - 115) / 20);
  return Math.round((1 + 9 / (1 + Math.exp(-1.5 * z))) * 10) / 10;
}
