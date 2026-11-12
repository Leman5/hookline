// Chorus detection from time-synced lyrics (LRC). Used when building seeds: the lines that repeat
// most mark the chorus, and their timestamps say where it is in the recording.

export interface LrcLine {
  t: number;
  text: string;
  norm: string;
}

/** "[01:02.34] text" lines -> [{ t, text, norm }]. */
export function parseLrc(lrc: string): LrcLine[] {
  const out: LrcLine[] = [];
  for (const line of lrc.split('\n')) {
    const stamps = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) out.push({ t: +m[1] * 60 + +m[2], text, norm: normLine(text) });
  }
  return out.sort((a, b) => a.t - b.t);
}

function normLine(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * The chorus is the stretch of lines that repeats most. Lines that occur more than once are
 * grouped into runs (one unrepeated line may sit inside a run; a long instrumental gap ends it),
 * each run is scored by how many different repeated lines it holds, and the first strong run that
 * is past the intro and in the first 60% of the song wins: outros often repeat the chorus many times.
 */
export function findChorus(lines: LrcLine[], songLen: number): { start: number; end: number; runs: number } | null {
  const ls = lines.filter((l) => l.norm.length >= 3);
  if (ls.length < 6) return null;
  const count = new Map<string, number>();
  for (const l of ls) count.set(l.norm, (count.get(l.norm) ?? 0) + 1);
  const rep = ls.map((l) => (count.get(l.norm) ?? 0) > 1);
  const GAP = 12;
  const runs: { start: number; end: number; lines: number; score: number }[] = [];
  for (let i = 0; i < ls.length; ) {
    if (!rep[i]) { i++; continue; }
    let j = i;
    for (;;) {
      if (j + 1 < ls.length && rep[j + 1] && ls[j + 1].t - ls[j].t < GAP) j++;
      else if (j + 2 < ls.length && rep[j + 2] && ls[j + 2].t - ls[j].t < GAP) j += 2;
      else break;
    }
    const after = ls[j + 1]?.t;
    const end = after !== undefined && after - ls[j].t < GAP ? after : Math.min(songLen, ls[j].t + 6);
    const distinct = new Set(ls.slice(i, j + 1).filter((_, k) => rep[i + k]).map((l) => l.norm)).size;
    runs.push({ start: ls[i].t, end, lines: j - i + 1, score: distinct });
    i = j + 1;
  }
  const good = runs.filter((r) => r.lines >= 2 && r.end - r.start >= 8);
  if (!good.length) return null;
  const best = Math.max(...good.map((r) => r.score));
  const pick =
    good.find((r) => r.start >= 15 && r.start <= 0.6 * songLen && r.score >= 0.6 * best) ??
    good.find((r) => r.start >= 15 && r.score >= 0.6 * best) ??
    good.find((r) => r.score === best)!;
  return { start: pick.start, end: pick.end, runs: good.length };
}

