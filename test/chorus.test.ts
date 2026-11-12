import { describe, expect, it } from 'vitest';
import { findChorus, parseLrc } from '../src/chorus.ts';

const ts = (s: number) => `[${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')}]`;
const lrc = (rows: [number, string][]) => rows.map(([t, x]) => `${ts(t)} ${x}`).join('\n');

const VERSE_A = ['walking down the empty road', 'nothing left to carry home', 'every light is fading slow', 'and the night is all I know'];
const VERSE_B = ['morning comes without a sound', 'feet are heavy on the ground', 'still I keep on turning round', 'looking for what I have found'];
const CHORUS = ['we rise up tonight', 'burning so bright', 'we rise up tonight', 'into the light'];

/** intro 0-20, verse 20-44, chorus 44-60, verse 70-94, chorus 94-110, outro chorus x2 150-182. */
function song(): string {
  const rows: [number, string][] = [];
  VERSE_A.forEach((l, i) => rows.push([20 + i * 6, l]));
  CHORUS.forEach((l, i) => rows.push([44 + i * 4, l]));
  VERSE_B.forEach((l, i) => rows.push([70 + i * 6, l]));
  CHORUS.forEach((l, i) => rows.push([94 + i * 4, l]));
  for (const base of [150, 166]) CHORUS.forEach((l, i) => rows.push([base + i * 4, l]));
  return lrc(rows);
}

describe('synced lyrics', () => {
  it('parses timestamps, including lines with several stamps', () => {
    const lines = parseLrc('[00:12.50] Hello, World!\n[01:02.00][02:04.10] Again\nno stamp');
    expect(lines.map((l) => l.t)).toEqual([12.5, 62, 124.1]);
    expect(lines[0].norm).toBe('hello world');
  });

  it('finds the first chorus, not the repeated outro', () => {
    const c = findChorus(parseLrc(song()), 190);
    expect(c).not.toBeNull();
    expect(c!.start).toBe(44);
    expect(c!.end).toBeGreaterThanOrEqual(56);
    expect(c!.end).toBeLessThanOrEqual(70);
  });

  it('works on non-Latin lyrics', () => {
    const hi = ['रे लठ गाड़ दूँ', 'दंगल दंगल', 'रे लठ गाड़ दूँ', 'दंगल दंगल'];
    const rows: [number, string][] = [];
    ['एक', 'दो तीन', 'चार पाँच', 'छह सात'].forEach((l, i) => rows.push([10 + i * 5, `${l} पंक्ति`]));
    hi.forEach((l, i) => rows.push([32 + i * 5, l]));
    ['आठ नौ', 'दस ग्यारह'].forEach((l, i) => rows.push([60 + i * 5, `${l} पंक्ति`]));
    hi.forEach((l, i) => rows.push([80 + i * 5, l]));
    expect(findChorus(parseLrc(lrc(rows)), 120)?.start).toBe(32);
  });

  it('gives up when nothing repeats', () => {
    const rows: [number, string][] = [...VERSE_A, ...VERSE_B].map((l, i) => [10 + i * 6, l]);
    expect(findChorus(parseLrc(lrc(rows)), 100)).toBeNull();
  });
});
