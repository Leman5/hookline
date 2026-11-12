import { describe, expect, it } from 'vitest';
import { AUTO_MATCH, normalizeTitle, songSimilarity } from '../src/match.ts';
import { fitChorus, parseSeed } from '../src/library.ts';

describe('matching', () => {
  it('strips film credits, features and versions', () => {
    expect(normalizeTitle('Tum Tak (From "Raanjhanaa")')).toBe('tum tak');
    expect(normalizeTitle('Pani Da Rang - Male')).toBe('pani da rang');
    expect(normalizeTitle('Lemonade (feat. NAV)')).toBe('lemonade');
  });
  it('matches a tagged file to its store title', () => {
    expect(songSimilarity('Tum Tak', 'A.R. Rahman', 'Tum Tak (From "Raanjhanaa")', 'A.R. Rahman, Javed Ali & Keerthi Sagathia')).toBeGreaterThanOrEqual(AUTO_MATCH);
    expect(songSimilarity('Dangal', 'Daler Mehndi', 'Dangal', 'Daler Mehndi & Pritam')).toBeGreaterThanOrEqual(AUTO_MATCH);
  });
  it('rejects a different song by the same artist', () => {
    expect(songSimilarity('Kaun Hai Ye', 'Emiway Bantai', 'MERI TARAH KAUN', 'Emiway Bantai')).toBeLessThan(0.7);
  });
});

describe('seed links', () => {
  it('parses country and both lists', () => {
    expect(parseSeed('in;c:1,2~dQw4w9WgXcQ.aqz-KE-bpKQ~212;g:3~dQw4w9WgXcQ~200~44.5-61')).toEqual({
      country: 'in',
      lists: {
        commute: [
          { id: 1, yt: undefined, ytDur: undefined, hook: undefined },
          { id: 2, yt: ['dQw4w9WgXcQ', 'aqz-KE-bpKQ'], ytDur: 212, hook: undefined },
        ],
        gym: [{ id: 3, yt: ['dQw4w9WgXcQ'], ytDur: 200, hook: { start: 44.5, end: 61 } }],
      },
    });
  });
  it('ignores a malformed chorus', () => {
    expect(parseSeed('in;g:3~dQw4w9WgXcQ~200~61-44')!.lists.gym[0].hook).toBeUndefined();
  });
  it('plays a detected chorus within each playlist\'s bounds', () => {
    // Gym: 1 s lead-in, at least 25 s. Commute: 2 s lead-in, at most 70 s.
    expect(fitChorus({ start: 44, end: 60 }, 'gym', 200)).toEqual({ start: 43, end: 68 });
    expect(fitChorus({ start: 44, end: 160 }, 'commute', 200)).toEqual({ start: 42, end: 112 });
    expect(fitChorus({ start: 180, end: 199 }, 'commute', 200).end).toBe(199);
  });
  it('rejects junk', () => {
    expect(parseSeed('hello')).toBeNull();
  });
});
