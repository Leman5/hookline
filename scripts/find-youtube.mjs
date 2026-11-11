#!/usr/bin/env node
// Find the YouTube video for each resolved seed song with the official YouTube Data API (free key),
// then write the private seed link with "itunesId~videoId~seconds" entries.
//
// Usage: node scripts/find-youtube.mjs private/seeds.json [appUrl]
// The key is read from private/youtube-key.txt (or YT_KEY). It never leaves this machine.
// Free quota allows ~100 searches a day; results are cached in private/youtube.json and
// a re-run continues where the last one stopped. Gym songs are searched first.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { normalizeArtist, normalizeTitle, dice } from '../src/match.ts';

const [, , seedsPath = 'private/seeds.json', appUrl = 'https://leman5.github.io/hookline/'] = process.argv;
const key = (process.env.YT_KEY ?? (existsSync('private/youtube-key.txt') ? readFileSync('private/youtube-key.txt', 'utf8') : '')).trim();
if (!key) {
  console.error('No API key: put it in private/youtube-key.txt');
  process.exit(2);
}
const cachePath = 'private/youtube.json';
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
const seeds = JSON.parse(readFileSync(seedsPath, 'utf8')).filter((s) => s.id && s.score >= 0.7);
const api = 'https://www.googleapis.com/youtube/v3';

const BAD = /\b(slowed|reverb|lofi|lo-fi|8d|remix|cover|karaoke|instrumental|status|ringtone|shorts|reaction|mashup|unplugged|female version|lyrical whatsapp)\b/i;

function isoSeconds(d) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d ?? '');
  return m ? (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + (+(m[3] ?? 0)) : 0;
}

function score(song, cand) {
  const want = normalizeTitle(song.title);
  const title = normalizeTitle(cand.title.replace(/\|/g, ' - '));
  const full = cand.title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ');
  const titleScore = full.includes(want) || title.includes(want) ? 1 : dice(want, title);
  const artists = normalizeArtist(song.artist);
  const hay = `${full} ${cand.channel.toLowerCase()}`;
  const artistHit = artists.some((a) => a.length > 2 && hay.includes(a)) ? 1 : 0;
  let s = 0.6 * titleScore + 0.25 * artistHit;
  // Auto-generated "Artist - Topic" uploads are the plain studio audio: no film dialogue intro.
  if (/ - topic$/i.test(cand.channel)) s += 0.15;
  if (BAD.test(cand.title) && !BAD.test(song.title)) s -= 0.5;
  if (!(cand.seconds >= 90 && cand.seconds <= 12 * 60)) s -= 1;
  if (!cand.embeddable) s -= 2;
  return s;
}

async function get(path, params) {
  const url = `${api}/${path}?${new URLSearchParams({ ...params, key })}`;
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason ?? res.status;
    throw Object.assign(new Error(`YouTube API ${path}: ${reason}`), { reason });
  }
  return body;
}

const order = [...seeds.filter((s) => s.list === 'gym'), ...seeds.filter((s) => s.list !== 'gym')];
let searched = 0, stopped = false;
for (const song of order) {
  if (cache[song.id]?.videoId !== undefined) continue;
  try {
    const q = `${song.title.replace(/\(.*?\)/g, '')} ${song.artist.split(/,|&/)[0]}`;
    const r = await get('search', { part: 'snippet', type: 'video', videoEmbeddable: 'true', videoCategoryId: '10', maxResults: '8', regionCode: 'IN', q });
    const ids = r.items.map((i) => i.id.videoId).filter(Boolean);
    const v = ids.length ? await get('videos', { part: 'contentDetails,status', id: ids.join(',') }) : { items: [] };
    const meta = new Map(v.items.map((i) => [i.id, { seconds: isoSeconds(i.contentDetails?.duration), embeddable: i.status?.embeddable !== false }]));
    const cands = r.items
      .filter((i) => i.id.videoId)
      .map((i) => ({ id: i.id.videoId, title: i.snippet.title, channel: i.snippet.channelTitle, ...meta.get(i.id.videoId) }));
    const ranked = cands.map((c) => ({ sc: score(song, c), c })).sort((a, b) => b.sc - a.sc);
    const best = ranked[0];
    // Keep up to three good uploads: some labels block embedding, and the app tries them in order.
    const good = ranked.filter((r) => r.sc >= 0.6 && Math.abs(r.c.seconds - best.c.seconds) < 90).slice(0, 3);
    const ok = good.length > 0;
    cache[song.id] = ok
      ? { videoId: best.c.id, alt: good.slice(1).map((r) => r.c.id), seconds: best.c.seconds, title: best.c.title, channel: best.c.channel, score: +best.sc.toFixed(2) }
      : { videoId: null, candidate: best?.c.title ?? null, score: best ? +best.sc.toFixed(2) : 0 };
    searched++;
    console.log(`${ok ? best.sc.toFixed(2) : 'MISS'}  ${song.list.padEnd(7)} ${song.title}  ->  ${ok ? `${best.c.title} [${best.c.channel}] ${best.c.seconds}s` : best?.c.title ?? 'no results'}`);
    writeFileSync(cachePath, JSON.stringify(cache, null, 1));
  } catch (e) {
    if (e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded') {
      console.log(`Daily quota used up after ${searched} searches. Run again tomorrow to finish the rest.`);
      stopped = true;
      break;
    }
    throw e;
  }
}

const entry = (s) => {
  const y = cache[s.id];
  return y?.videoId ? `${s.id}~${[y.videoId, ...(y.alt ?? [])].join('.')}~${y.seconds}` : `${s.id}`;
};
const ids = (l) => [...new Map(seeds.filter((s) => s.list === l).map((s) => [s.id, entry(s)])).values()].join(',');
const link = `${appUrl}#seed=in;c:${ids('commute')};g:${ids('gym')}`;
writeFileSync('private/seeds-link.txt', link + '\n');
const found = seeds.filter((s) => cache[s.id]?.videoId).length;
console.log(`${found}/${seeds.length} songs have a YouTube video${stopped ? ' (more tomorrow)' : ''}. Seed link: private/seeds-link.txt`);
