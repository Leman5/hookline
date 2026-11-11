#!/usr/bin/env node
// Resolve a TSV seed list ("c|g <TAB> title <TAB> artist") to iTunes track IDs, then print a private seed link.
// Usage: node scripts/resolve-seeds.mjs private/seeds-input.tsv private/seeds.json [country] [appUrl]
// Uses the free iTunes Search API, throttled to stay under ~20 requests/minute. Re-runs skip resolved rows.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { songSimilarity } from '../src/match.ts';

const [, , input, output, country = 'in', appUrl = 'https://leman5.github.io/hookline/'] = process.argv;
if (!input || !output) {
  console.error('usage: resolve-seeds.mjs <input.tsv> <output.json> [country] [appUrl]');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const prev = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : [];
const done = new Map(prev.filter((s) => s.id).map((s) => [`${s.list}|${s.q}`, s]));
const rows = readFileSync(input, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t'));
const out = [];

for (const [l, title, artist] of rows) {
  const list = l === 'g' ? 'gym' : 'commute';
  const q = `${title} ${artist}`;
  const cached = done.get(`${list}|${q}`);
  if (cached) { out.push(cached); continue; }
  const url = `https://itunes.apple.com/search?${new URLSearchParams({ term: q, entity: 'song', country, limit: '8' })}`;
  let results = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) { results = (await res.json()).results ?? []; break; }
      console.error(`  HTTP ${res.status}, retrying`);
    } catch (e) {
      console.error(`  ${e.cause?.code ?? e.message}, retrying`);
    }
    await sleep(10000);
  }
  let best = null;
  for (const r of results) {
    if (!r.previewUrl) continue;
    const score = songSimilarity(title, artist, r.trackName, r.artistName);
    if (!best || score > best.score) best = { score, r };
  }
  const entry = best && best.score >= 0.7
    ? { list, q, id: best.r.trackId, title: best.r.trackName, artist: best.r.artistName, score: +best.score.toFixed(2) }
    : { list, q, id: null, title, artist, score: best ? +best.score.toFixed(2) : 0, candidate: best?.r.trackName };
  out.push(entry);
  console.log(`${entry.score.toFixed(2)}  ${list.padEnd(7)} ${q}  ->  ${entry.id ? `${entry.title} / ${entry.artist}` : `NOT FOUND (${entry.candidate ?? 'no results'})`}`);
  writeFileSync(output, JSON.stringify(out, null, 1));
  await sleep(3200);
}
writeFileSync(output, JSON.stringify(out, null, 1));
const ids = (l) => [...new Set(out.filter((s) => s.id && s.list === l).map((s) => s.id))].join(',');
const link = `${appUrl}#seed=${country};c:${ids('commute')};g:${ids('gym')}`;
writeFileSync(output.replace(/\.json$/, '-link.txt'), link + '\n');
console.log(`resolved ${out.filter((s) => s.id).length}/${out.length}`);
console.log(`seed link written to ${output.replace(/\.json$/, '-link.txt')}`);
