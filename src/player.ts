// Playback engine.
//
// Two routes per highlight:
//  - "yt":    the full song in the visible YouTube player, used only while the screen is on.
//  - "audio": two <audio> decks (Apple preview or the user's own file) that crossfade. Advancing is
//             driven by media events (timeupdate/ended), which keep firing while the phone is locked.
//
// While YouTube plays, the active <audio> deck loops a few seconds of silence (the "keeper"), so the
// page always owns a playing media element. When the screen locks, YouTube is paused and the keeper
// deck switches to the audio version of the same song: a src change on an already-playing element,
// which Chrome allows in the background. Audio never goes through Web Audio.
import { log } from './debuglog.ts';
import { artworkUrl, audioUrl, buildQueue, markPlayed, refreshPreviews, saveTrack, settings, type QueueItem } from './library.ts';
import { bindControls, setMetadata, setPlaybackState, setPosition } from './mediaSession.ts';
import { emit } from './state.ts';
import { PROFILES, type ListId } from './types.ts';
import { YT_ENDED, YT_PAUSED, YT_PLAYING, YouTubeDeck } from './youtube.ts';

interface Deck {
  el: HTMLAudioElement;
  item?: QueueItem;
  url?: string;
  revoke?: boolean;
  /** Pending load of `item`; resolves when metadata is in and the deck is seeked to the start. */
  loading?: Promise<boolean>;
}

export type Route = 'audio' | 'yt';

/** A silent 8 kHz WAV, long enough (6 s) for Chrome to treat it as real media. */
function silenceUrl(seconds: number): string {
  const n = 8000 * seconds;
  const b = new DataView(new ArrayBuffer(44 + n));
  const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); b.setUint32(4, 36 + n, true); str(8, 'WAVE'); str(12, 'fmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 8000, true); b.setUint32(28, 8000, true); b.setUint16(32, 1, true); b.setUint16(34, 8, true);
  str(36, 'data'); b.setUint32(40, n, true);
  for (let i = 0; i < n; i++) b.setUint8(44 + i, 128);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

function waitFor(el: HTMLAudioElement, ok: string[], bad: string[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(timer);
      for (const e of ok) el.removeEventListener(e, yes);
      for (const e of bad) el.removeEventListener(e, no);
      resolve(v);
    };
    const yes = () => done(true);
    const no = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    for (const e of ok) el.addEventListener(e, yes, { once: true });
    for (const e of bad) el.addEventListener(e, no, { once: true });
  });
}

const ALBUM: Record<ListId, string> = { commute: 'Hookline · Commute', gym: 'Hookline · Gym' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Player {
  private decks: [Deck, Deck];
  private active = 0;
  private keeper: string;
  readonly yt: YouTubeDeck;
  queue: QueueItem[] = [];
  idx = -1;
  list: ListId | null = null;
  /** What the user wants: true after play, false after pause. */
  wantPlaying = false;
  /** The highlight playing now and how. */
  now: { item: QueueItem; route: Route } | null = null;
  private transitioning = false;
  private fade: { from: Deck; to: Deck; start: number; len: number; timer: number } | null = null;
  private ownPause = new WeakSet<HTMLAudioElement>();
  private lastTimeupdate = 0;
  private stallTimer: number | undefined;
  private ytTimer: number | undefined;
  /** The browser stopped YouTube in the background (phone locked): use audio until the screen is back. */
  private ytSuspended = false;
  private ytStalledSince = 0;
  /** Where to pick the full song up when the screen comes back mid-song (seconds into the hook). */
  private ytResumeAt = 0;
  private unlocked = false;

  constructor(container: HTMLElement, ytHost: HTMLElement) {
    const make = (): Deck => {
      const el = document.createElement('audio');
      el.preload = 'auto';
      el.setAttribute('playsinline', '');
      container.appendChild(el);
      const d: Deck = { el };
      el.addEventListener('timeupdate', () => this.onTime(d));
      el.addEventListener('ended', () => this.onEnded(d));
      el.addEventListener('error', () => this.onError(d));
      el.addEventListener('pause', () => this.onPause(d));
      el.addEventListener('play', () => this.onPlay(d));
      el.addEventListener('waiting', () => this.onWaiting(d));
      el.addEventListener('playing', () => clearTimeout(this.stallTimer));
      return d;
    };
    this.decks = [make(), make()];
    this.keeper = silenceUrl(6);
    this.yt = new YouTubeDeck(ytHost);
    this.yt.onState = (s) => {
      if (this.now?.route !== 'yt' || this.transitioning) return;
      if (s === YT_ENDED) void this.next(true);
      // Keep our state in sync when the user taps YouTube's own pause/play controls.
      else if (s === YT_PAUSED && this.wantPlaying && document.visibilityState === 'hidden') void this.ytStopped('paused in the background');
      else if (s === YT_PAUSED && this.wantPlaying && document.visibilityState === 'visible') {
        this.wantPlaying = false;
        this.quietPause(this.cur.el);
        setPlaybackState(false);
        emit('player');
      } else if (s === YT_PLAYING && !this.wantPlaying) {
        this.wantPlaying = true;
        void this.keeperOn();
        this.startYtWatch();
        setPlaybackState(true);
        emit('player');
      }
    };
    this.yt.onError = (code) => this.onYtError(code);
    bindControls({
      play: () => void this.resume(),
      pause: () => this.pause(),
      next: () => void this.next(false),
      prev: () => void this.prev(),
      seek: (rel) => this.seek(rel),
      position: () => this.position(),
    });
    document.addEventListener('visibilitychange', () => this.onVisibility());
  }

  private get cur(): Deck {
    return this.decks[this.active];
  }
  private get idle(): Deck {
    return this.decks[1 - this.active];
  }
  get current(): QueueItem | undefined {
    return this.now?.item;
  }
  get route(): Route | undefined {
    return this.now?.route;
  }

  /** Warm up the YouTube player so the first song starts quickly. */
  preloadYouTube(): void {
    if (settings.youtube) void this.yt.init();
  }

  private routeFor(item: QueueItem): Route {
    const blocked = this.ytSuspended && document.visibilityState === 'hidden';
    return settings.youtube && item.yt && !item.track.ytBroken && !blocked ? 'yt' : 'audio';
  }

  /** Start a playlist. Must be called from a user gesture. */
  async start(list: ListId, firstId?: string): Promise<void> {
    this.unlock();
    this.list = list;
    this.queue = buildQueue(list, firstId);
    if (!this.queue.length) {
      log('player', `nothing to play in ${list}`);
      return;
    }
    this.stopFade();
    this.stopYt();
    for (const d of this.decks) this.unload(d);
    this.now = null;
    this.idx = -1;
    this.wantPlaying = true;
    log('player', `start ${list}: ${this.queue.length} highlights`);
    await this.next(false);
  }

  /** Let both decks produce sound later without a new tap. */
  private unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    for (const d of this.decks) {
      d.el.src = this.keeper;
      d.el.play().then(
        () => this.quietPause(d.el),
        () => {},
      );
    }
  }

  /** Pause without it being mistaken for a system pause (call, audio focus loss). */
  private quietPause(el: HTMLAudioElement): void {
    if (el.paused) return;
    this.ownPause.add(el);
    el.pause();
  }

  private unload(d: Deck): void {
    if (d.revoke && d.url) URL.revokeObjectURL(d.url);
    d.item = undefined;
    d.url = undefined;
    d.revoke = false;
    d.loading = undefined;
    this.quietPause(d.el);
    d.el.loop = false;
    d.el.removeAttribute('src');
    d.el.load();
  }

  /** Put silence on the active deck (keeps the page's media session alive under YouTube). */
  private async keeperOn(): Promise<void> {
    const d = this.cur;
    if (d.el.loop && d.el.src === this.keeper && !d.el.paused) return;
    if (d.revoke && d.url) URL.revokeObjectURL(d.url);
    d.item = undefined;
    d.url = undefined;
    d.revoke = false;
    d.loading = undefined;
    d.el.loop = true;
    d.el.volume = 1;
    d.el.src = this.keeper;
    await this.playEl(d);
  }

  private load(d: Deck, item: QueueItem): Promise<boolean> {
    if (d.item === item && d.loading) return d.loading;
    const run = async () => {
      if (d.revoke && d.url) URL.revokeObjectURL(d.url);
      d.item = item;
      d.el.loop = false;
      try {
        const { url, revoke } = await audioUrl(item.track);
        if (d.item !== item) {
          if (revoke) URL.revokeObjectURL(url);
          return false;
        }
        d.url = url;
        d.revoke = revoke;
        d.el.src = url;
        d.el.load();
      } catch (e) {
        log('error', `${item.track.title}: ${(e as Error).message}`);
        return false;
      }
      const ok = await waitFor(d.el, ['loadedmetadata'], ['error'], 20000);
      if (!ok || d.item !== item) return false;
      if (item.seg.start > 0) {
        d.el.currentTime = item.seg.start;
        await waitFor(d.el, ['seeked'], ['error'], 8000);
      }
      return d.item === item;
    };
    d.loading = run();
    return d.loading;
  }

  private async playEl(d: Deck): Promise<boolean> {
    try {
      await d.el.play();
      return true;
    } catch (e) {
      log('error', `play() rejected: ${(e as Error).name}`);
      return false;
    }
  }

  /** End time of the current audio highlight on a deck, in media seconds. */
  private segEnd(d: Deck): number {
    const dur = Number.isFinite(d.el.duration) ? d.el.duration : Infinity;
    const end = d.item && d.item.seg.end > 0 ? d.item.seg.end : dur;
    return Math.min(end, dur);
  }

  private fadeLen(): number {
    return settings.crossfade && this.list ? PROFILES[this.list].crossfade : 0;
  }

  position(): { pos: number; len: number } {
    if (this.now?.route === 'yt' && this.now.item.yt) {
      const { start, end } = this.now.item.yt;
      return { pos: this.yt.time() - start, len: end - start };
    }
    const d = this.cur;
    if (!d.item) return { pos: 0, len: 0 };
    const start = d.item.seg.start;
    const end = this.segEnd(d);
    return { pos: d.el.currentTime - start, len: Number.isFinite(end) ? end - start : 0 };
  }

  private began(item: QueueItem, route: Route): void {
    this.now = { item, route };
    markPlayed(item.track.id);
    const t = item.track;
    const part = item.parts > 1 ? ` (${item.part + 1}/${item.parts})` : '';
    void artworkUrl(t).then((art) => setMetadata(t.title + part, t.artist, ALBUM[item.list], art));
    setPlaybackState(true);
    this.syncPosition();
    const at = route === 'yt' ? item.yt!.start : item.seg.start;
    log('play', `${t.title}${part} via ${route === 'yt' ? 'YouTube' : t.source} @${at.toFixed(1)}s`);
    emit('player');
    void this.preloadNext();
  }

  private syncPosition(): void {
    const { pos, len } = this.position();
    setPosition(pos, len);
  }

  private async preloadNext(): Promise<void> {
    // The idle deck is still the outgoing one while a crossfade runs; stopFade() calls back here.
    if (this.fade) return;
    const n = this.queue[this.idx + 1];
    // Always have the audio version ready: it is what plays if the screen locks mid-song.
    if (!n || (this.now?.route === 'yt' && this.routeFor(n) === 'yt' && n !== this.now.item)) {
      if (this.now?.route === 'yt') void this.load(this.idle, this.now.item);
      return;
    }
    const ok = await this.load(this.idle, n);
    if (!ok && this.queue[this.idx + 1] === n && !this.transitioning) {
      log('skip', `cannot load ${n.track.title}`);
      this.dropItem(this.idx + 1);
      void this.preloadNext();
    }
  }

  private dropItem(i: number): void {
    const bad = this.queue[i];
    if (bad?.track.source === 'preview') void refreshPreviews(true);
    this.queue.splice(i, 1);
  }

  // ---------- audio deck events ----------

  private onTime(d: Deck): void {
    // While YouTube plays, the silent keeper's timeupdates keep firing even on a locked phone.
    if (this.now?.route === 'yt') return this.checkYt();
    if (d !== this.cur || !d.item || this.now?.route !== 'audio') return;
    const now = performance.now();
    if (this.lastTimeupdate && now - this.lastTimeupdate > 1500 && !d.el.paused) {
      log('gap', `${Math.round(now - this.lastTimeupdate)} ms between timeupdates (${document.visibilityState})`);
    }
    this.lastTimeupdate = now;
    if (this.fade) this.stepFade();
    if (!this.transitioning && this.wantPlaying && d.el.currentTime >= this.segEnd(d) - this.fadeLen() - 0.1) {
      void this.next(true);
    }
    emit('player');
  }

  private onEnded(d: Deck): void {
    if (d === this.cur && d.item && this.now?.route === 'audio' && !this.transitioning) void this.next(true);
  }

  private onError(d: Deck): void {
    if (!d.item || !d.el.getAttribute('src') || d.el.loop) return;
    log('error', `media error ${d.el.error?.code} on ${d.item.track.title}`);
    if (d === this.cur && this.now?.route === 'audio' && !this.transitioning) {
      if (d.item.track.source === 'preview') void refreshPreviews(true);
      void this.next(true);
    }
  }

  private onPause(d: Deck): void {
    if (this.ownPause.has(d.el)) {
      this.ownPause.delete(d.el);
      return;
    }
    if (d !== this.cur || this.transitioning || d.el.ended) return;
    // Paused by the system (call, audio focus, headset unplugged). Stay paused.
    this.wantPlaying = false;
    this.stopFade();
    if (this.now?.route === 'yt') this.yt.pause();
    setPlaybackState(false);
    this.syncPosition();
    log('player', 'paused by system');
    emit('player');
  }

  private onPlay(d: Deck): void {
    if (d === this.cur && this.now && !this.wantPlaying && !d.el.loop) {
      this.wantPlaying = true;
      setPlaybackState(true);
      emit('player');
    }
  }

  private onWaiting(d: Deck): void {
    if (d !== this.cur || this.now?.route !== 'audio') return;
    clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (d === this.cur && this.wantPlaying && d.el.readyState < 3) {
        log('skip', `stalled on ${d.item?.track.title}`);
        void this.next(false);
      }
    }, 10000) as unknown as number;
  }

  // ---------- YouTube route ----------

  private startYtWatch(): void {
    clearInterval(this.ytTimer);
    this.ytTimer = setInterval(() => {
      const n = this.now;
      if (!n || n.route !== 'yt' || !n.item.yt || this.transitioning || !this.wantPlaying) return;
      this.checkYt();
      const t = this.yt.time();
      const fade = this.fadeLen();
      const left = n.item.yt.end - t;
      if (fade > 0 && left < fade) this.yt.setVolume(100 * Math.max(0, left / fade));
      if (left <= 0.1) void this.next(true);
      emit('player');
    }, 250) as unknown as number;
  }

  private stopYt(): void {
    clearInterval(this.ytTimer);
    this.ytTimer = undefined;
    if (this.now?.route === 'yt') this.yt.pause();
  }

  private onYtError(code: number): void {
    const n = this.now;
    log('error', `YouTube error ${code}${n ? ` on ${n.item.track.title}` : ''}`);
    // 100: removed, 101/150: embedding disabled. Remember, and use the audio version from now on.
    if (n && (code === 100 || code === 101 || code === 150)) void saveTrack({ ...n.item.track, ytBroken: true });
  }

  /**
   * Going to the background does not by itself stop YouTube (desktop tabs, some phones keep playing),
   * so only switch to audio once the browser has actually paused or stalled the video.
   */
  private checkYt(): void {
    if (document.visibilityState !== 'hidden' || this.now?.route !== 'yt' || !this.wantPlaying || this.transitioning) {
      this.ytStalledSince = 0;
      return;
    }
    const s = this.yt.state();
    if (s === YT_PLAYING) {
      this.ytStalledSince = 0;
    } else if (s === YT_PAUSED) {
      void this.ytStopped('paused in the background');
    } else {
      const now = performance.now();
      if (!this.ytStalledSince) this.ytStalledSince = now;
      else if (now - this.ytStalledSince > 3000) void this.ytStopped(`stalled in the background (state ${s})`);
    }
  }

  private async ytStopped(why: string): Promise<void> {
    if (this.now?.route !== 'yt' || !this.wantPlaying || this.transitioning) return;
    log('handoff', `YouTube ${why}`);
    this.ytSuspended = true;
    this.ytStalledSince = 0;
    await this.handOff();
  }

  private onVisibility(): void {
    log('visibility', document.visibilityState);
    if (document.visibilityState !== 'visible') return;
    // Screen back on: full songs again, picking the current song up where its audio version is.
    const wasSuspended = this.ytSuspended;
    this.ytSuspended = false;
    const n = this.now;
    if (!wasSuspended || !n || n.route !== 'audio' || !this.wantPlaying || this.transitioning) return;
    if (!settings.youtube || !n.item.yt || n.item.track.ytBroken) return;
    this.ytResumeAt = this.position().pos;
    log('handoff', `screen on: ${n.item.track.title} continues in full`);
    this.idx -= 1;
    void this.next(false);
  }

  private async handOff(): Promise<void> {
    if (this.transitioning) {
      // Let the running transition finish, then re-check.
      await sleep(300);
      if (this.now?.route === 'yt' && this.ytSuspended && document.visibilityState === 'hidden') return this.handOff();
      return;
    }
    const item = this.now!.item;
    this.stopYt();
    log('handoff', `${item.track.title} continues as the ${item.track.source}`);
    this.idx -= 1; // replay the same queue item through the audio route
    await this.next(false, true);
  }

  // ---------- transitions ----------

  /** Advance to the next highlight. auto = reached the end of the current one. */
  async next(auto: boolean, forceAudio = false): Promise<void> {
    if (this.transitioning || !this.list) return;
    this.transitioning = true;
    try {
      this.stopFade();
      let ni = this.idx + 1;
      if (ni >= this.queue.length) {
        // Start over with a fresh shuffle, avoiding an immediate repeat of the current song.
        const curId = this.now?.item.track.id;
        const q = buildQueue(this.list);
        if (q.length > 1 && q[0].track.id === curId) q.push(q.shift()!);
        this.queue = [...this.queue.slice(0, this.idx + 1), ...q];
        log('player', 'queue reshuffled');
      }
      const fromYt = this.now?.route === 'yt';
      for (let target: QueueItem | undefined; (target = this.queue[ni]); ) {
        const route = forceAudio ? 'audio' : this.routeFor(target);
        if (route === 'yt' && this.wantPlaying) {
          if (await this.playYt(target, fromYt)) {
            this.idx = ni;
            this.began(target, 'yt');
            return;
          }
          // YouTube failed: fall through to the audio version of the same song. In the background
          // that usually means the browser will not start new videos, so stay on audio until visible.
          if (document.visibilityState === 'hidden') this.ytSuspended = true;
        }
        if (fromYt) this.stopYt();
        if (await this.load(this.idle, target)) {
          await this.switchAudio(target, auto);
          this.idx = ni;
          this.began(target, 'audio');
          return;
        }
        log('skip', `cannot load ${target.track.title}`);
        this.dropItem(ni);
      }
      log('player', 'nothing playable left');
      this.pause();
    } finally {
      this.transitioning = false;
    }
  }

  private async playYt(target: QueueItem, fromYt: boolean): Promise<boolean> {
    const fade = this.fadeLen();
    if (fromYt && fade > 0) {
      // Finish the outgoing fade before reusing the single YouTube player.
      for (let v = 100; v > 0; v -= 20) {
        this.yt.setVolume(v);
        await sleep((fade * 1000) / 5);
      }
    }
    clearInterval(this.ytTimer);
    // Quiet any audio deck still playing and keep the page's media session alive with silence.
    if (this.cur.item) {
      const d = this.cur;
      for (let i = 4; i >= 0 && fade > 0; i--) {
        d.el.volume = i / 5;
        await sleep(60);
      }
    }
    await this.keeperOn();
    // Try each known upload of the song: labels often block embedding on some of them.
    const t = target.track;
    const into = this.ytResumeAt;
    this.ytResumeAt = 0;
    const hookLen = target.yt!.end - target.yt!.start;
    const startAt = target.yt!.start + (into > 0 && into < hookLen - 8 ? into : 0);
    const ids = [t.youtubeId!, ...(t.youtubeAlt ?? [])];
    let ok = false, permanent = true;
    for (let i = 0; i < ids.length && !ok; i++) {
      const r = await this.yt.play(ids[i], startAt, fade > 0 ? 30 : 100);
      ok = r.ok;
      if (ok) {
        if (i > 0) {
          const fixed = { ...t, youtubeId: ids[i], youtubeAlt: ids.slice(i + 1) };
          target.track = fixed;
          void saveTrack(fixed);
        }
      } else {
        log('error', `YouTube ${r.code || 'timeout'} on ${t.title} (${ids[i]})`);
        if (r.code !== 100 && r.code !== 101 && r.code !== 150) {
          permanent = false; // network trouble or timeout: keep the videos for next time
          // A background tab will not start any video, so trying the other uploads only adds silence.
          if (document.visibilityState === 'hidden') break;
        }
      }
    }
    if (!ok) {
      const latest = target.track;
      if (permanent) {
        target.track = { ...latest, ytBroken: true };
        void saveTrack(target.track);
      }
      log('fallback', `YouTube could not play ${t.title}; using the ${t.source}`);
      return false;
    }
    if (fade > 0) void this.rampYtVolume(30, 100, fade);
    this.startYtWatch();
    return true;
  }

  private async rampYtVolume(from: number, to: number, seconds: number): Promise<void> {
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await sleep((seconds * 1000) / steps);
      if (this.now?.route !== 'yt') return;
      this.yt.setVolume(from + ((to - from) * i) / steps);
    }
  }

  /** The idle deck holds `target`, loaded and seeked. Make it the active deck. */
  private async switchAudio(target: QueueItem, auto: boolean): Promise<void> {
    const from = this.cur, to = this.idle;
    if (!this.wantPlaying) {
      this.unload(from);
      this.active = 1 - this.active;
      return;
    }
    const len = auto ? this.fadeLen() : Math.min(0.3, this.fadeLen());
    to.el.volume = len > 0 ? 0 : 1;
    if (!(await this.playEl(to))) {
      // Background play() on the second element was refused: reuse the element that is already playing.
      log('fallback', 'hard cut on the active element');
      from.el.loop = false;
      from.el.src = to.el.src;
      [from.url, to.url] = [to.url, undefined];
      [from.revoke, to.revoke] = [to.revoke, false];
      from.item = target;
      to.item = undefined;
      await waitFor(from.el, ['loadedmetadata'], ['error'], 15000);
      from.el.currentTime = target.seg.start;
      from.el.volume = 1;
      await this.playEl(from);
      return;
    }
    this.active = 1 - this.active;
    if (len > 0 && !from.el.paused) this.startFade(from, to, len);
    else {
      to.el.volume = 1;
      this.unload(from);
    }
  }

  async prev(): Promise<void> {
    const { pos } = this.position();
    if (pos > 3 || this.idx <= 0) return this.seek(0);
    if (this.transitioning) return;
    this.idx -= 2;
    await this.next(false);
  }

  /** Jump straight to the queue item at index i. */
  async jump(i: number): Promise<void> {
    if (i < 0 || i >= this.queue.length || this.transitioning) return;
    this.idx = i - 1;
    this.unload(this.idle);
    await this.next(false);
  }

  private startFade(from: Deck, to: Deck, len: number): void {
    const timer = setInterval(() => this.stepFade(), 40) as unknown as number;
    this.fade = { from, to, start: performance.now(), len: len * 1000, timer };
    this.stepFade();
  }

  private stepFade(): void {
    const f = this.fade;
    if (!f) return;
    const x = Math.min(1, (performance.now() - f.start) / f.len);
    // Equal-power curves keep perceived loudness steady through the fade.
    f.to.el.volume = Math.sin((x * Math.PI) / 2);
    f.from.el.volume = Math.cos((x * Math.PI) / 2);
    if (x >= 1) this.stopFade();
  }

  private stopFade(): void {
    const f = this.fade;
    if (!f) return;
    clearInterval(f.timer);
    this.fade = null;
    f.to.el.volume = 1;
    if (f.from !== this.cur) this.unload(f.from);
    void this.preloadNext();
  }

  pause(): void {
    this.wantPlaying = false;
    this.stopFade();
    if (this.now?.route === 'yt') this.yt.pause();
    for (const d of this.decks) this.quietPause(d.el);
    setPlaybackState(false);
    this.syncPosition();
    emit('player');
  }

  async resume(): Promise<void> {
    if (!this.now) {
      if (this.list) await this.start(this.list);
      return;
    }
    this.unlock();
    this.wantPlaying = true;
    if (this.now.route === 'yt') {
      if (document.visibilityState === 'hidden') {
        // Lock-screen play button: a paused background video usually cannot restart, so use audio.
        this.ytSuspended = true;
        await this.keeperOn();
        await this.handOff();
        return;
      }
      await this.keeperOn();
      this.yt.setVolume(100);
      this.yt.resume();
      this.startYtWatch();
    } else {
      this.cur.el.volume = 1;
      await this.playEl(this.cur);
    }
    setPlaybackState(true);
    this.syncPosition();
    emit('player');
  }

  toggle(): void {
    if (this.wantPlaying) this.pause();
    else void this.resume();
  }

  /** Seek within the current highlight (seconds from its start). */
  seek(rel: number): void {
    const n = this.now;
    if (!n) return;
    if (n.route === 'yt' && n.item.yt) {
      const { start, end } = n.item.yt;
      this.yt.seek(Math.max(start, Math.min(end - 1, start + rel)));
    } else {
      const d = this.cur;
      if (!d.item) return;
      const start = d.item.seg.start;
      d.el.currentTime = Math.max(start, Math.min(this.segEnd(d) - 0.5, start + rel));
    }
    this.syncPosition();
    emit('player');
  }

  /** Rebuild the upcoming part of the queue after settings or segments change. */
  refreshQueue(): void {
    if (!this.list || !this.now) return;
    const curId = this.now.item.track.id;
    const rest = buildQueue(this.list).filter((q) => q.track.id !== curId);
    this.queue = [...this.queue.slice(0, this.idx + 1), ...rest];
    if (!this.fade) {
      if (this.now.route === 'audio') this.unload(this.idle);
      void this.preloadNext();
    }
    emit('player');
  }
}
