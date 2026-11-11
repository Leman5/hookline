import type { ListProfile, Segment } from '../types.ts';
import type { BeatFeatures } from './structure.ts';

export interface Candidate extends Segment {
  score: number;
  startBeat: number;
  endBeat: number;
}

interface Pre {
  loud: Float64Array;
  rep: Float64Array;
  onset: Float64Array;
  db: Float64Array;
}

const prefix = (x: Float32Array) => {
  const p = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) p[i + 1] = p[i] + x[i];
  return p;
};
const mean = (p: Float64Array, a: number, b: number) => (b > a ? (p[b] - p[a]) / (b - a) : 0);

/** Every bar-aligned window whose length fits the profile, scored as a highlight. */
export function scoreCandidates(bf: BeatFeatures, downbeat: number, profile: ListProfile, duration: number): Candidate[] {
  const pre: Pre = { loud: prefix(bf.loudPct), rep: prefix(bf.rep), onset: prefix(bf.onsetPct), db: prefix(bf.loudDb) };
  const introEnd = Math.max(15, 0.08 * duration);
  const outroStart = duration - Math.max(10, 0.05 * duration);
  const out: Candidate[] = [];
  const B = bf.count;
  for (let s = downbeat; s < B; s += 4) {
    const t0 = bf.times[s];
    for (let bars = 1; s + bars * 4 <= B; bars++) {
      const e = s + bars * 4;
      const t1 = bf.times[e];
      const len = t1 - t0;
      if (len < profile.minLen) continue;
      if (len > profile.maxLen) break;
      const loud = mean(pre.loud, s, e);
      const rep = mean(pre.rep, s, e);
      const onset = mean(pre.onset, s, e);
      const before = mean(pre.db, Math.max(0, s - 8), s);
      const after = mean(pre.db, s, Math.min(B, s + 8));
      const jump = s >= 8 ? Math.min(1, Math.max(0, (after - before) / 10)) : 0;
      // Ending right before the music drops (end of a chorus) sounds like a natural exit.
      const tail = mean(pre.db, Math.max(s, e - 8), e);
      const next = mean(pre.db, e, Math.min(B, e + 8));
      const exit = e + 8 <= B ? Math.min(1, Math.max(0, (tail - next) / 10)) : 0.5;
      const fit = Math.exp(-0.5 * ((len - profile.target) / (0.35 * profile.target)) ** 2);
      const penalty = (t0 < introEnd ? 1 : 0) + (t1 > outroStart ? 1 : 0);
      const score =
        profile.wLoud * loud +
        profile.wRep * rep +
        profile.wOnset * onset +
        0.1 * jump +
        0.1 * exit +
        0.1 * fit +
        0.05 * bf.novelty[s] +
        (bars % 4 === 0 ? 0.02 : 0) -
        penalty;
      out.push({ start: t0, end: t1, score, startBeat: s, endBeat: e });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function meanChroma(bf: BeatFeatures, a: number, b: number): Float32Array {
  const v = new Float32Array(12);
  for (let i = a; i < b; i++) for (let k = 0; k < 12; k++) v[k] += bf.chroma[i * 12 + k];
  let n = 0;
  for (let k = 0; k < 12; k++) n += v[k] * v[k];
  n = Math.sqrt(n) || 1;
  for (let k = 0; k < 12; k++) v[k] /= n;
  return v;
}

const cosine = (a: Float32Array, b: Float32Array) => a.reduce((s, x, k) => s + x * b[k], 0);

/** Pick up to profile.maxSegments non-overlapping, musically distinct highlights in time order. */
export function chooseSegments(bf: BeatFeatures, downbeat: number, profile: ListProfile, duration: number): Segment[] {
  if (duration < profile.minLen + 10) return [{ start: 0, end: duration }];
  const cands = scoreCandidates(bf, downbeat, profile, duration);
  if (!cands.length) return [{ start: 0, end: duration }];
  const picked: Candidate[] = [cands[0]];
  const first = cands[0];
  const firstChroma = meanChroma(bf, first.startBeat, first.endBeat);
  for (const c of cands) {
    if (picked.length >= profile.maxSegments) break;
    if (c.score < 0.85 * first.score) break;
    const clear = picked.every((p) => c.endBeat + 32 <= p.startBeat || c.startBeat >= p.endBeat + 32);
    if (!clear) continue;
    if (cosine(meanChroma(bf, c.startBeat, c.endBeat), firstChroma) >= 0.85) continue;
    picked.push(c);
  }
  return picked
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ start: round(c.start), end: round(c.end) }));
}

const round = (x: number) => Math.round(x * 100) / 100;
