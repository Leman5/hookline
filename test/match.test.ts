import { describe, expect, it } from 'vitest';
import { AUTO_MATCH, normalizeTitle, songSimilarity } from '../src/match.ts';
import { parseSeed } from '../src/library.ts';

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
    expect(parseSeed('in;c:1,2~dQw4w9WgXcQ.aqz-KE-bpKQ~212;g:3')).toEqual({
      country: 'in',
      lists: {
        commute: [{ id: 1, yt: undefined, ytDur: undefined }, { id: 2, yt: ['dQw4w9WgXcQ', 'aqz-KE-bpKQ'], ytDur: 212 }],
        gym: [{ id: 3, yt: undefined, ytDur: undefined }],
      },
    });
  });
  it('rejects junk', () => {
    expect(parseSeed('hello')).toBeNull();
  });
});
