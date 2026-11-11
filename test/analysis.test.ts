import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analysis/analyze.ts';
import { extractFeatures } from '../src/analysis/features.ts';
import { fft } from '../src/analysis/fft.ts';
import { estimateTempo } from '../src/analysis/tempo.ts';
import type { Segment } from '../src/types.ts';

const SR = 11025;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function decode(path: string): Float32Array {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(String(r.stderr));
  const b = r.stdout as Buffer;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function clicks(bpm: number, seconds: number): Float32Array {
  const pcm = new Float32Array(SR * seconds);
  const period = 60 / bpm;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / SR;
    const ph = t % period;
    pcm[i] = 0.6 * Math.exp(-40 * ph) * Math.sin(2 * Math.PI * 80 * t) + 0.01 * Math.sin(2 * Math.PI * 440 * t);
  }
  return pcm;
}

const iou = (a: Segment, s: number, e: number) => {
  const inter = Math.max(0, Math.min(a.end, e) - Math.max(a.start, s));
  return inter / (Math.max(a.end, e) - Math.min(a.start, s));
};

describe('fft', () => {
  it('puts a sine at its bin', () => {
    const n = 1024, k = 37;
    const re = new Float32Array(n), im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * k * i) / n);
    fft(re, im);
    const mags = Array.from({ length: n / 2 }, (_, i) => Math.hypot(re[i], im[i]));
    expect(mags.indexOf(Math.max(...mags))).toBe(k);
  });
});

describe('tempo', () => {
  for (const bpm of [90, 120, 128, 174]) {
    it(`finds ${bpm} BPM on a click track`, () => {
      const t = estimateTempo(extractFeatures(clicks(bpm, 40), SR));
      expect(t.confident).toBe(true);
      // 174 may legitimately read as 87 (half time); accept exact or octave-folded only for that case.
      const ok = Math.abs(t.bpm - bpm) <= 2 || (bpm > 160 && Math.abs(t.bpm * 2 - bpm) <= 2);
      expect(ok, `got ${t.bpm}`).toBe(true);
    });
  }
});

describe.runIf(hasFfmpeg && existsSync('test/fixtures/song120.mp3'))('fixture song', () => {
  const pcm = decode('test/fixtures/song120.mp3');
  const t0 = performance.now();
  const a = analyze(pcm, SR);
  const ms = performance.now() - t0;

  it('reads the tempo', () => {
    expect(a.confident).toBe(true);
    expect(Math.abs(a.bpm - 120)).toBeLessThanOrEqual(2);
  });

  it('picks a chorus for commute', () => {
    const [seg] = a.segments.commute;
    const best = Math.max(iou(seg, 50, 80), iou(seg, 110, 140));
    expect(best, JSON.stringify(a.segments.commute)).toBeGreaterThanOrEqual(0.45);
    // Starts within one bar (2 s at 120 BPM) of a chorus entrance.
    expect(Math.min(Math.abs(seg.start - 50), Math.abs(seg.start - 110))).toBeLessThanOrEqual(2.1);
  });

  it('picks a chorus for gym and never the same chorus twice', () => {
    const segs = a.segments.gym;
    const first = segs.find((s) => iou(s, 50, 80) >= 0.7 || iou(s, 110, 140) >= 0.7);
    expect(first, JSON.stringify(segs)).toBeTruthy();
    // Gym starts within a beat of the chorus entrance.
    expect(Math.min(Math.abs(first!.start - 50), Math.abs(first!.start - 110))).toBeLessThanOrEqual(0.6);
    const choruses = segs.filter((s) => iou(s, 50, 80) >= 0.5 || iou(s, 110, 140) >= 0.5);
    expect(choruses.length).toBe(1);
  });

  it('is fast enough', () => {
    expect(ms).toBeLessThan(3000);
    console.log(`analysis of 160 s took ${ms.toFixed(0)} ms; energy ${a.energy}; segments ${JSON.stringify(a.segments)}`);
  });
});

describe.runIf(hasFfmpeg && existsSync('test/fixtures/pink.mp3'))('noise', () => {
  it('falls back without crashing', () => {
    const a = analyze(decode('test/fixtures/pink.mp3'), SR);
    expect(a.confident).toBe(false);
    expect(a.segments.commute.length).toBe(1);
    expect(a.segments.gym.length).toBeGreaterThanOrEqual(1);
  });
});
