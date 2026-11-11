// Thin wrapper over the official YouTube IFrame Player API. The player stays visible while it plays,
// as YouTube's terms require; it is only used while the screen is on.
/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export const YT_PLAYING = 1;
export const YT_ENDED = 0;
export const YT_PAUSED = 2;

export class YouTubeDeck {
  private player: any = null;
  private ready: Promise<boolean> | null = null;
  onState: (state: number) => void = () => {};
  onError: (code: number) => void = () => {};

  constructor(private host: HTMLElement) {}

  /** Load the API and create the player once. Resolves false when YouTube cannot be reached. */
  init(): Promise<boolean> {
    this.ready ??= new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      const create = () => {
        const div = document.createElement('div');
        this.host.append(div);
        this.player = new window.YT.Player(div, {
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, controls: 1, iv_load_policy: 3, origin: location.origin },
          events: {
            onReady: () => {
              clearTimeout(timer);
              resolve(true);
            },
            onStateChange: (e: { data: number }) => this.onState(e.data),
            onError: (e: { data: number }) => this.onError(e.data),
          },
        });
      };
      if (window.YT?.Player) return create();
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        create();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      document.head.append(s);
    });
    return this.ready;
  }

  /**
   * Load a video at a start time and wait until it is actually playing.
   * Resolves with the YouTube error code on failure (0 for a timeout or no API).
   */
  async play(videoId: string, start: number, volume: number): Promise<{ ok: boolean; code: number }> {
    if (!(await this.init())) return { ok: false, code: 0 };
    const p = this.player;
    return new Promise((resolve) => {
      let done = false;
      const prevErr = this.onError;
      const finish = (ok: boolean, code = 0) => {
        if (done) return;
        done = true;
        this.onError = prevErr;
        clearTimeout(timer);
        clearInterval(poll);
        resolve({ ok, code });
      };
      // Errors while loading belong to this video, not to whatever played before.
      this.onError = (code) => finish(false, code);
      const timer = setTimeout(() => finish(false), 12000);
      const poll = setInterval(() => {
        if (p.getPlayerState?.() === YT_PLAYING) finish(true);
      }, 100);
      p.setVolume(volume);
      p.unMute();
      p.loadVideoById({ videoId, startSeconds: start });
    });
  }

  pause(): void {
    this.player?.pauseVideo?.();
  }
  resume(): void {
    this.player?.playVideo?.();
  }
  stop(): void {
    this.player?.stopVideo?.();
  }
  time(): number {
    return this.player?.getCurrentTime?.() ?? 0;
  }
  state(): number {
    return this.player?.getPlayerState?.() ?? -1;
  }
  seek(t: number): void {
    this.player?.seekTo?.(t, true);
  }
  setVolume(v: number): void {
    this.player?.setVolume?.(Math.round(Math.max(0, Math.min(100, v))));
  }
}
