#!/usr/bin/env node
// Find where each song's chorus is, from time-synced lyrics in the free LRCLIB database
// (https://lrclib.net), then line the timing up with the song's YouTube upload.
//
// Usage: node scripts/find-hooks.mjs [private/seeds.json]
// Needs private/youtube.json from find-youtube.mjs and the YouTube key (only for video lengths,
// 1 quota unit per 50 videos). Results are cached in private/youtube.json; re-runs are cheap.
// Afterwards run find-youtube.mjs again to rewrite the seed link with the chorus times.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { findChorus, parseLrc } from '../src/chorus.ts';
import { dice, normalizeArtist, normalizeTitle } from '../src/match.ts';

const seedsPath = process.argv[2] ?? 'private/seeds.json';
const cachePath = 'private/youtube.json';
const key = (process.env.YT_KEY ?? (existsSync('private/youtube-key.txt') ? readFileSync('private/youtube-key.txt', 'utf8') : '')).trim();
const cache = JSON.parse(readFileSync(cachePath, 'utf8'));
const seeds = [...new Map(JSON.parse(readFileSync(seedsPath, 'utf8')).filter((s) => s.id && s.score >= 0.7).map((s) => [s.id, s])).values()];
const UA = { 'user-agent': 'hookline (https://github.com/Leman5/hookline)' };
const MAX_SHIFT = 3.5; // seconds of length difference treated as the same recording

// ---------- lyrics lookup ----------

function cleanTitle(t) {
  return t
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((from|feat|ft|with)\b[^)]*\)/gi, ' ')
    .replace(/\s-\s.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const lyricsPath = 'private/lyrics.json';
const lyricsCache = existsSync(lyricsPath) ? JSON.parse(readFileSync(lyricsPath, 'utf8')) : {};

/** GET JSON with retries: LRCLIB sometimes drops or rate-limits requests. Returns null when it gives up. */
async function getJson(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: UA });
      if (res.ok) return await res.json();
      if (res.status === 404) return [];
    } catch {
      // network hiccup: retry
    }
    await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  return null;
}

async function lrclib(song) {
  if (lyricsCache[song.id]) return lyricsCache[song.id];
  const hits = await lrclibSearch(song);
  if (hits) lyricsCache[song.id] = hits.map((h) => ({ duration: h.duration, syncedLyrics: h.syncedLyrics }));
  return hits ?? [];
}

async function lrclibSearch(song) {
  const title = cleanTitle(song.title);
  const artist = song.artist.split(/,|&| x /i)[0].trim();
  const tries = [{ track_name: title, artist_name: artist }, { track_name: title }];
  let failed = false;
  for (const q of tries) {
    const body = await getJson(`https://lrclib.net/api/search?${new URLSearchParams(q)}`);
    if (body === null) { failed = true; continue; }
    const want = normalizeTitle(title);
    const artists = normalizeArtist(song.artist);
    const hits = body.filter((r) => {
      if (!r.syncedLyrics || r.instrumental) return false;
      const titleOk = dice(want, normalizeTitle(r.trackName)) >= 0.7 || normalizeTitle(r.trackName).includes(want);
      const artistOk = !q.artist_name ? artists.some((a) => normalizeTitle(r.artistName).includes(a)) : true;
      return titleOk && artistOk;
    });
    if (hits.length) return hits;
  }
  return failed ? null : [];
}

// ---------- YouTube lengths ----------

async function videoLengths(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const url = `https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'contentDetails', id: ids.slice(i, i + 50).join(','), key })}`;
    const res = await fetch(url);
    const body = await res.json();
    if (!res.ok) throw new Error(`YouTube API: ${body?.error?.errors?.[0]?.reason ?? res.status}`);
    for (const v of body.items) {
      const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(v.contentDetails.duration);
      out.set(v.id, m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : 0);
    }
  }
  return out;
}

/** One YouTube search (100 quota units) for an embeddable upload as long as the synced lyrics. */
async function searchAligned(song, hits) {
  if (song.searchedAligned) return null;
  const q = `${cleanTitle(song.title)} ${song.artist.split(/,|&/)[0]} audio`;
  const url = `https://www.googleapis.com/youtube/v3/search?${new URLSearchParams({ part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '10', regionCode: 'IN', q, key })}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    console.log(`  (YouTube search stopped: ${body?.error?.errors?.[0]?.reason ?? res.status})`);
    return null;
  }
  const want = normalizeTitle(cleanTitle(song.title));
  const BAD = /\b(slowed|reverb|lofi|lo-fi|8d|remix|cover|karaoke|instrumental|status|shorts|reaction|mashup|live)\b/i;
  const cands = body.items.filter((i) => {
    const t = normalizeTitle(i.snippet.title.replace(/\|/g, ' - '));
    const full = i.snippet.title.toLowerCase();
    return (t.includes(want) || full.includes(want) || dice(want, t) >= 0.7) && !(BAD.test(i.snippet.title) && !BAD.test(song.title));
  });
  // A named version (vocals only, reprise, live...) must stay that version.
  const VERSION = /\b(vocals? only|reprise|live|remix|unplugged|acoustic|jhankar|encore|radio edit|lofi|female|male)\b/gi;
  const need = [...new Set((song.title.match(VERSION) ?? []).map((v) => v.toLowerCase()))];
  for (let i = cands.length - 1; i >= 0; i--) {
    const t = cands[i].snippet.title.toLowerCase();
    if (!need.every((v) => t.includes(v))) cands.splice(i, 1);
  }
  if (!cands.length) return null;
  const lens = await videoLengths(cands.map((c) => c.id.videoId));
  let pick = null;
  for (const c of cands) {
    const len = lens.get(c.id.videoId);
    for (const h of hits) {
      const d = Math.abs(len - h.duration);
      if (d <= MAX_SHIFT && (!pick || d < pick.d)) pick = { id: c.id.videoId, len, h, d, title: c.snippet.title };
    }
  }
  if (pick) console.log(`  new upload  ${song.title} -> ${pick.title}`);
  return pick;
}

// ---------- run ----------

const todo = seeds.filter((s) => cache[s.id]?.videoId);
const allIds = [...new Set(todo.flatMap((s) => [cache[s.id].videoId, ...(cache[s.id].alt ?? [])]))];
const lengths = key ? await videoLengths(allIds) : new Map();
const tally = { chorus: 0, noLyrics: 0, noChorus: 0, noMatch: 0 };

for (const song of todo) {
  const y = cache[song.id];
  const ids = [y.videoId, ...(y.alt ?? [])];
  const hits = await lrclib(song);
  if (!hits.length) {
    tally.noLyrics++;
    delete y.hook;
    console.log(`  no lyrics   ${song.list.padEnd(7)} ${song.title}`);
    continue;
  }
  // Pick the upload and the lyrics whose lengths agree: then the lyric times are the video times.
  let best = null;
  for (const id of ids) {
    const len = lengths.get(id);
    if (!len) continue;
    for (const h of hits) {
      const d = Math.abs(len - h.duration);
      if (!best || d < best.d) best = { id, len, h, d };
    }
  }
  if ((!best || best.d > MAX_SHIFT) && key) {
    // Look for another upload (often the plain audio) whose length matches the lyrics.
    const found = await searchAligned(song, hits);
    if (found) {
      ids.unshift(found.id);
      lengths.set(found.id, found.len);
      best = { id: found.id, len: found.len, h: found.h, d: found.d };
    }
  }
  if (!best || best.d > MAX_SHIFT) {
    tally.noMatch++;
    delete y.hook;
    console.log(`  no aligned  ${song.list.padEnd(7)} ${song.title}  (closest length gap ${best ? best.d.toFixed(1) : '?'} s)`);
    continue;
  }
  const chorus = findChorus(parseLrc(best.h.syncedLyrics), best.len);
  if (!chorus) {
    tally.noChorus++;
    delete y.hook;
    console.log(`  no chorus   ${song.list.padEnd(7)} ${song.title}`);
    continue;
  }
  // The aligned upload plays first; the others stay as fallbacks (their timing may differ slightly).
  y.videoId = best.id;
  y.alt = ids.filter((i) => i !== best.id);
  y.seconds = best.len;
  y.hook = { start: +chorus.start.toFixed(1), end: +chorus.end.toFixed(1) };
  tally.chorus++;
  const mm = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  console.log(`  chorus      ${song.list.padEnd(7)} ${song.title}  ${mm(chorus.start)}–${mm(chorus.end)}`);
}

writeFileSync(cachePath, JSON.stringify(cache, null, 1));
writeFileSync(lyricsPath, JSON.stringify(lyricsCache));
console.log(`\n${tally.chorus}/${todo.length} songs have a detected chorus (${tally.noLyrics} without synced lyrics, ${tally.noMatch} with no upload matching the lyrics' length, ${tally.noChorus} without a clear chorus).`);
console.log('Now run: node scripts/find-youtube.mjs ' + seedsPath);
