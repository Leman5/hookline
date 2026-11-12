// The library: tracks, analyses, user edits, settings, seeds and queue building.
import { ANALYSIS_VERSION } from './analysis/analyze.ts';
import { foldBpm } from './analysis/tempo.ts';
import * as db from './db.ts';
import { log } from './debuglog.ts';
import { AUTO_MATCH, songSimilarity } from './match.ts';
import { emit } from './state.ts';
import { readTags, sha256 } from './tags.ts';
import { LISTS, type Analysis, type ListId, type Segment, type Track } from './types.ts';

export interface Settings {
  mode: 'highlights' | 'full';
  crossfade: boolean;
  previews: boolean;
  /** Play the full song from YouTube while the screen is on. */
  youtube: boolean;
  country: string;
  /** Settings layout version, for one-time changes on update. */
  v?: number;
}

export const tracks = new Map<string, Track>();
export const analyses = new Map<string, Analysis>();
export const overrides = new Map<string, Partial<Record<ListId, Segment[]>>>();
export let settings: Settings = { mode: 'highlights', crossfade: true, previews: true, youtube: true, country: 'in' };
let history: Record<string, number> = {};

export async function load(): Promise<void> {
  const [ts, as, os, s, h] = await Promise.all([
    db.all<Track>('tracks'),
    db.all<Analysis & { id: string }>('analysis'),
    db.all<{ id: string; segs: Partial<Record<ListId, Segment[]>> }>('overrides'),
    db.get<Settings>('kv', 'settings'),
    db.get<Record<string, number>>('kv', 'history'),
  ]);
  for (const t of ts) tracks.set(t.id, t);
  for (const a of as) if (a.version === ANALYSIS_VERSION) analyses.set(a.id, a);
  for (const o of os) overrides.set(o.id, o.segs);
  if (s) settings = { ...settings, ...s };
  if ((settings.v ?? 0) < 2) {
    // Version 2 detects each song's chorus: start everyone on highlights once, whatever the old toggle said.
    settings = { ...settings, mode: 'highlights', v: 2 };
    await db.put('kv', 'settings', settings);
  }
  history = h ?? {};
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  settings = { ...settings, ...patch };
  await db.put('kv', 'settings', settings);
  emit('library');
}

export async function saveTrack(t: Track): Promise<void> {
  tracks.set(t.id, t);
  await db.put('tracks', t.id, t);
}

export async function moveTrack(id: string): Promise<void> {
  const t = tracks.get(id);
  if (!t) return;
  await saveTrack({ ...t, list: t.list === 'gym' ? 'commute' : 'gym', pinned: true });
  emit('library');
}

export async function removeTrack(id: string): Promise<void> {
  const t = tracks.get(id);
  if (!t) return;
  tracks.delete(id);
  await db.del('tracks', id);
  if (t.hash) await Promise.all([db.del('blobs', t.hash), db.del('blobs', `cover:${t.hash}`)]);
  if (t.replaces) {
    const p = tracks.get(t.replaces);
    if (p) await saveTrack({ ...p, hidden: false });
  }
  emit('library');
}

export function analysisOf(t: Track): Analysis | undefined {
  return t.hash ? analyses.get(`${t.hash}:${ANALYSIS_VERSION}`) : undefined;
}

/** The highlight windows to play for a track in a list. end < 0 means "to the end". */
export function segmentsFor(t: Track, list: ListId, mode = settings.mode): Segment[] {
  if (mode === 'full') return [{ start: 0, end: -1 }];
  const o = overrides.get(t.id)?.[list];
  if (o?.length) return o;
  if (t.source === 'preview') return [{ start: 0, end: -1 }];
  return analysisOf(t)?.segments[list] ?? [{ start: 0, end: -1 }];
}

/** Hook length for full YouTube songs when no chorus was detected. */
const YT_HOOK: Record<ListId, number> = { commute: 75, gym: 65 };
/** How much of a detected chorus to play: a short lead-in before it, then the chorus within these bounds. */
const CHORUS_FIT: Record<ListId, { lead: number; min: number; max: number }> = {
  commute: { lead: 2, min: 40, max: 70 },
  gym: { lead: 1, min: 25, max: 50 },
};

export const ytKey = (id: string) => `${id}#yt`;

/** Play the detected chorus from just before it starts, at least min and at most max seconds. */
export function fitChorus(hook: Segment, list: ListId, dur: number): Segment {
  const f = CHORUS_FIT[list];
  const start = Math.max(0, hook.start - f.lead);
  const len = Math.min(f.max, Math.max(f.min, hook.end + 1 - start));
  return { start, end: Math.max(start + 5, Math.min(dur - 1, start + len)) };
}

/** The window of the full YouTube song to play. No audio access, so: user edit, else a typical hook position. */
export function ytSegmentFor(t: Track, list: ListId, mode = settings.mode): Segment | undefined {
  if (!t.youtubeId || t.ytBroken) return undefined;
  const dur = t.ytDuration ?? 240;
  if (mode === 'full') return { start: 0, end: dur };
  const o = overrides.get(ytKey(t.id))?.[list]?.[0];
  if (o) return o;
  if (t.ytHook) return fitChorus(t.ytHook, list, dur);
  // No lyrics to go by: film songs usually reach the first chorus 10-15% in, after the intro.
  const start = Math.round(Math.min(45, Math.max(15, 0.11 * dur)));
  return { start, end: Math.min(dur - 5, start + YT_HOOK[list]) };
}

export async function setOverride(id: string, list: ListId, segs: Segment[] | null): Promise<void> {
  const cur = { ...(overrides.get(id) ?? {}) };
  if (segs) cur[list] = segs;
  else delete cur[list];
  overrides.set(id, cur);
  await db.put('overrides', id, { id, segs: cur });
  emit('library');
}

export function visible(list: ListId): Track[] {
  return [...tracks.values()]
    .filter((t) => t.list === list && !t.hidden && (t.source === 'file' || settings.previews))
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ---------- history and queue ----------

const DAY = 24 * 60 * 60 * 1000;

export function markPlayed(id: string): void {
  history[id] = Date.now();
  void db.put('kv', 'history', history);
}

export function resetHistory(): void {
  history = {};
  void db.put('kv', 'history', history);
}

export interface QueueItem {
  track: Track;
  list: ListId;
  /** Window of the audio source (file or preview), used when the screen is locked or YouTube is off. */
  seg: Segment;
  /** Window of the full YouTube song, when there is one. */
  yt?: Segment;
  /** Index of this segment within the track's segments, and how many there are. */
  part: number;
  parts: number;
}

/** Fresh songs (not played in 24 h) in random order first, then the rest oldest-played first. */
export function buildQueue(list: ListId, firstId?: string): QueueItem[] {
  const now = Date.now();
  const all = visible(list);
  const fresh = all.filter((t) => !(now - (history[t.id] ?? 0) < DAY));
  const stale = all.filter((t) => now - (history[t.id] ?? 0) < DAY).sort((a, b) => (history[a.id] ?? 0) - (history[b.id] ?? 0));
  for (let i = fresh.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fresh[i], fresh[j]] = [fresh[j], fresh[i]];
  }
  const order = [...fresh, ...stale];
  if (firstId) {
    const i = order.findIndex((t) => t.id === firstId);
    if (i > 0) order.unshift(...order.splice(i, 1));
  }
  return order.flatMap((track) => {
    const segs = segmentsFor(track, list);
    // Previews with a YouTube video play one long hook; imported files already have full-song highlights.
    const yt = track.source === 'preview' ? ytSegmentFor(track, list) : undefined;
    if (yt) return [{ track, list, seg: segs[0], yt, part: 0, parts: 1 }];
    return segs.map((seg, part) => ({ track, list, seg, part, parts: segs.length }));
  });
}

// ---------- seeds (from the private #seed= link) and the free iTunes lookup ----------

interface ItunesTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  previewUrl?: string;
  artworkUrl100?: string;
  trackViewUrl?: string;
  trackTimeMillis?: number;
}

export interface SeedEntry {
  id: number;
  /** Candidate YouTube video ids, best first. */
  yt?: string[];
  ytDur?: number;
  /** Chorus start and end in the first video, when one was detected. */
  hook?: Segment;
}

/** "in;c:1~vidA.vidB~245,2;g:3" -> country and entries per list. "~videoIds~seconds" is optional. */
export function parseSeed(raw: string): { country: string; lists: Record<ListId, SeedEntry[]> } | null {
  const parts = decodeURIComponent(raw).split(';');
  const lists: Record<ListId, SeedEntry[]> = { commute: [], gym: [] };
  let country = 'in';
  for (const p of parts) {
    const [k, v = ''] = p.split(':');
    const entries = v
      .split(',')
      .map((e): SeedEntry => {
        const [id, yt, dur, hook] = e.split('~');
        const [hs, he] = (hook ?? '').split('-').map(Number);
        return {
          id: Number(id),
          yt: yt ? yt.split('.').filter((v) => /^[\w-]{11}$/.test(v)) : undefined,
          ytDur: dur && Number(dur) > 0 ? Number(dur) : undefined,
          hook: hs >= 0 && he > hs ? { start: hs, end: he } : undefined,
        };
      })
      .filter((e) => Number.isInteger(e.id) && e.id > 0);
    if (k === 'c') lists.commute.push(...entries);
    else if (k === 'g') lists.gym.push(...entries);
    else if (/^[a-z]{2}$/.test(k) && !v) country = k;
  }
  return lists.commute.length + lists.gym.length ? { country, lists } : null;
}

async function lookup(ids: number[], country: string): Promise<ItunesTrack[]> {
  const out: ItunesTrack[] = [];
  for (let i = 0; i < ids.length; i += 150) {
    const url = `https://itunes.apple.com/lookup?id=${ids.slice(i, i + 150).join(',')}&country=${country}&entity=song`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`iTunes lookup failed (${res.status})`);
    const body = (await res.json()) as { results: (ItunesTrack & { wrapperType?: string })[] };
    out.push(...body.results.filter((r) => r.wrapperType === 'track' || r.trackId));
  }
  return out;
}

/** Create or refresh preview tracks from a seed. Keeps the user's moves and hidden flags. */
export async function applySeed(raw: string): Promise<number> {
  const seed = parseSeed(raw);
  if (!seed) throw new Error('That seed link is not valid.');
  await saveSettings({ country: seed.country });
  await db.put('kv', 'seed', raw);
  const listOf = new Map<number, ListId>();
  const ytOf = new Map<number, SeedEntry>();
  for (const l of LISTS) {
    for (const e of seed.lists[l]) {
      listOf.set(e.id, l);
      if (e.yt?.length) ytOf.set(e.id, e);
    }
  }
  const found = await lookup([...listOf.keys()], seed.country);
  const now = Date.now();
  const batch: [string, unknown][] = [];
  for (const r of found) {
    if (!r.previewUrl) continue;
    const id = `it:${r.trackId}`;
    const prev = tracks.get(id);
    const t: Track = {
      id,
      title: r.trackName,
      artist: r.artistName,
      list: prev?.pinned ? prev.list : (listOf.get(r.trackId) ?? 'commute'),
      pinned: prev?.pinned,
      hidden: prev?.hidden,
      source: 'preview',
      itunesId: r.trackId,
      previewUrl: r.previewUrl,
      appleUrl: r.trackViewUrl,
      artwork: r.artworkUrl100?.replace(/100x100bb/, '512x512bb'),
      duration: r.trackTimeMillis ? r.trackTimeMillis / 1000 : undefined,
      youtubeId: ytOf.get(r.trackId)?.yt?.[0] ?? prev?.youtubeId,
      youtubeAlt: ytOf.has(r.trackId) ? ytOf.get(r.trackId)!.yt!.slice(1) : prev?.youtubeAlt,
      ytDuration: ytOf.get(r.trackId)?.ytDur ?? prev?.ytDuration ?? (r.trackTimeMillis ? r.trackTimeMillis / 1000 : undefined),
      ytHook: ytOf.has(r.trackId) ? ytOf.get(r.trackId)!.hook : prev?.ytHook,
      ytBroken: ytOf.has(r.trackId) ? false : prev?.ytBroken,
      addedAt: prev?.addedAt ?? now,
    };
    tracks.set(id, t);
    batch.push([id, t]);
  }
  await db.putMany('tracks', batch);
  await db.put('kv', 'lookupAt', now);
  log('seed', `${batch.length} previews from ${listOf.size} seeds`);
  emit('library');
  return batch.length;
}

/** Preview URLs can change; refresh them weekly, or right away after a playback error. */
export async function refreshPreviews(force = false): Promise<void> {
  const [raw, at] = await Promise.all([db.get<string>('kv', 'seed'), db.get<number>('kv', 'lookupAt')]);
  if (!raw || !navigator.onLine) return;
  if (!force && at && Date.now() - at < 7 * DAY) return;
  await applySeed(raw).catch((e) => log('seed', `refresh failed: ${e}`));
}

// ---------- importing the user's own files ----------

const SAMPLE_RATE = 11025;
let worker: Worker | null = null;
let nextJob = 0;
const jobs = new Map<number, { resolve: (a: Analysis) => void; reject: (e: Error) => void }>();

function analyzeInWorker(pcm: Float32Array): Promise<Analysis> {
  if (!worker) {
    worker = new Worker(new URL('./analysis/worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: Analysis; error?: string }>) => {
      const j = jobs.get(e.data.id);
      jobs.delete(e.data.id);
      if (!j) return;
      if (e.data.result) j.resolve(e.data.result);
      else j.reject(new Error(e.data.error ?? 'analysis failed'));
    };
  }
  const id = ++nextJob;
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject });
    worker!.postMessage({ id, pcm, sampleRate: SAMPLE_RATE }, [pcm.buffer]);
  });
}

/** Decode on the main thread (no AudioContext in workers) straight to 11 kHz, then mix to mono. */
async function decode(buf: ArrayBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const audio = await ctx.decodeAudioData(buf);
  const n = audio.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const ch = audio.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / audio.numberOfChannels;
  }
  return mono;
}

function autoAssign(a: Analysis): ListId {
  const bpm = foldBpm(a.bpm);
  if (a.energy >= 6.5 && bpm >= 110) return 'gym';
  if (a.energy <= 5 || (bpm > 0 && bpm < 100)) return 'commute';
  const energies = [...tracks.values()].map((t) => analysisOf(t)?.energy).filter((e): e is number => e !== undefined).sort((x, y) => x - y);
  const median = energies.length ? energies[Math.floor(energies.length / 2)] : 5.75;
  return a.energy > median ? 'gym' : 'commute';
}

export interface ImportProgress {
  name: string;
  status: string;
}

export async function importFiles(files: File[], progress: (p: ImportProgress) => void): Promise<void> {
  for (const file of files) {
    const name = file.name;
    try {
      progress({ name, status: 'reading' });
      const buf = await file.arrayBuffer();
      const hash = await sha256(buf);
      const id = `f:${hash}`;
      if (tracks.has(id)) {
        progress({ name, status: 'already added' });
        continue;
      }
      const tags = readTags(buf, name);
      await db.put('blobs', hash, file);
      if (tags.cover) await db.put('blobs', `cover:${hash}`, tags.cover);
      progress({ name, status: 'analysing' });
      const t0 = performance.now();
      const pcm = await decode(buf);
      const a = await analyzeInWorker(pcm);
      const key = `${hash}:${ANALYSIS_VERSION}`;
      analyses.set(key, a);
      await db.put('analysis', key, { ...a, id: key });
      log('analysis', `${name}: ${Math.round(performance.now() - t0)} ms, bpm ${a.bpm}, energy ${a.energy}`);

      const title = tags.title ?? name;
      const artist = tags.artist ?? '';
      let best: Track | undefined, bestScore = 0;
      for (const t of tracks.values()) {
        if (t.source !== 'preview') continue;
        const s = songSimilarity(title, artist, t.title, t.artist);
        if (s > bestScore) { bestScore = s; best = t; }
      }
      const matched = best && bestScore >= AUTO_MATCH ? best : undefined;
      if (matched) await saveTrack({ ...matched, hidden: true });
      await saveTrack({
        id,
        title: matched?.title ?? title,
        artist: matched?.artist ?? artist,
        list: matched?.list ?? autoAssign(a),
        source: 'file',
        hash,
        replaces: matched?.id,
        artwork: tags.cover ? 'cover' : matched?.artwork,
        duration: a.duration,
        addedAt: Date.now(),
      });
      progress({ name, status: matched ? `matched “${matched.title}”` : `added to ${tracks.get(id)!.list}` });
      emit('library');
    } catch (e) {
      progress({ name, status: `failed: ${(e as Error).message ?? e}` });
    }
  }
}

/** Object URL for an imported file's audio, or the preview URL. */
export async function audioUrl(t: Track): Promise<{ url: string; revoke: boolean }> {
  if (t.source === 'preview') return { url: t.previewUrl!, revoke: false };
  const blob = await db.get<Blob>('blobs', t.hash!);
  if (!blob) throw new Error('audio file missing; import it again');
  return { url: URL.createObjectURL(blob), revoke: true };
}

const coverUrls = new Map<string, string>();
export async function artworkUrl(t: Track): Promise<string | undefined> {
  if (t.artwork !== 'cover') return t.artwork;
  const cached = coverUrls.get(t.id);
  if (cached) return cached;
  const blob = await db.get<Blob>('blobs', `cover:${t.hash}`);
  if (!blob) return undefined;
  const url = URL.createObjectURL(blob);
  coverUrls.set(t.id, url);
  return url;
}
