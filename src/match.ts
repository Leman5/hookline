// Fuzzy title/artist matching, shared by the app and scripts/resolve-seeds.mjs.

/** Lowercase ASCII words; drops "(feat. ...)", "[...]", "From <film>", "- Remastered", "- Male" and similar. */
export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\((feat|ft|from|with)\b[^)]*\)?/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s-\s.*$/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeArtist(s: string): string[] {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/,|&|\bfeat\.?\b|\bft\.?\b|\bx\b|\band\b/)
    .map((a) => a.replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function bigrams(s: string): Map<string, number> {
  const t = ` ${s} `;
  const m = new Map<string, number>();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Sørensen–Dice similarity of character bigrams, 0..1. */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, total = 0;
  for (const [k, v] of A) {
    inter += Math.min(v, B.get(k) ?? 0);
    total += v;
  }
  for (const v of B.values()) total += v;
  return (2 * inter) / total;
}

/** Similarity of two (title, artist) pairs, 0..1. Artist is the best pair among the credited names. */
export function songSimilarity(t1: string, a1: string, t2: string, a2: string): number {
  const title = dice(normalizeTitle(t1), normalizeTitle(t2));
  const A1 = normalizeArtist(a1), A2 = normalizeArtist(a2);
  let artist = 0;
  for (const x of A1) for (const y of A2) artist = Math.max(artist, dice(x, y));
  if (!A1.length || !A2.length) artist = 0.5;
  return 0.65 * title + 0.35 * artist;
}

export const AUTO_MATCH = 0.78;
